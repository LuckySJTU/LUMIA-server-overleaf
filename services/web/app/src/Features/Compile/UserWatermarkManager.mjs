import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import Path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import logger from '@overleaf/logger'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'
import SessionManager from '../Authentication/SessionManager.mjs'
import TokenAccessHandler from '../TokenAccess/TokenAccessHandler.mjs'

const execFileAsync = promisify(execFile)
const PDF_OUTPUT_FILE = 'output.pdf'
const DEFAULT_PAGE_SIZE = { width: 595.276, height: 841.89 }
const MAX_PROCESS_OUTPUT_BUFFER_BYTES = 4 * 1024 * 1024
const PROCESS_TIMEOUT_MS = 60 * 1000
const HIDDEN_WATERMARK_ANNOTATION_FLAGS = 3
const QPDF_EXIT_CODE_WARNINGS = 3

async function isEnabledForProject(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    userWatermarkEnabled: 1,
  })
  return Boolean(project && project.userWatermarkEnabled)
}

async function getCompileResponseData(projectId, req) {
  const userWatermarkEnabled = await isEnabledForProject(projectId)
  let canDownloadUnwatermarkedPdf = false
  if (userWatermarkEnabled) {
    canDownloadUnwatermarkedPdf = await canUserManageProjectWatermark(
      req,
      projectId
    )
  }
  return {
    userWatermarkEnabled,
    canDownloadUnwatermarkedPdf,
  }
}

async function getPdfWatermarkRequest({ projectId, action, requestPath, req }) {
  if (!isPdfOutputRequest(action, requestPath, req)) {
    return {
      enabled: false,
      shouldWatermark: false,
      denyUnwatermarked: false,
    }
  }

  const userWatermarkEnabled = await isEnabledForProject(projectId)
  if (!userWatermarkEnabled) {
    return {
      enabled: false,
      shouldWatermark: false,
      denyUnwatermarked: false,
    }
  }

  if (wantsUnwatermarkedPdf(req)) {
    const canBypass = await canUserManageProjectWatermark(req, projectId)
    return {
      enabled: true,
      shouldWatermark: false,
      denyUnwatermarked: !canBypass,
    }
  }

  return {
    enabled: true,
    shouldWatermark: true,
    denyUnwatermarked: false,
    lines: buildWatermarkLines(req),
    invisibleText: buildInvisibleWatermarkText(req, projectId),
  }
}

function isPdfOutputRequest(action, requestPath, req) {
  if (action !== 'output-file') {
    return false
  }
  if (!req.params || !req.params.Project_id) {
    return false
  }

  const file = req.params.file || req.params.filename
  return file === PDF_OUTPUT_FILE || requestPath.endsWith('/output/output.pdf')
}

function wantsUnwatermarkedPdf(req) {
  if (!req.query) {
    return false
  }
  return req.query.unwatermarked === '1' || req.query.unwatermarked === 'true'
}

async function canUserManageProjectWatermark(req, projectId) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    return false
  }
  const token = TokenAccessHandler.getRequestToken(req, projectId)
  return await AuthorizationManager.promises.canUserAdminProject(
    userId,
    projectId,
    token
  )
}

function buildWatermarkLines(req) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  return ['LUMIA Internal', `User ID: ${userId || 'anonymous'}`]
}

function buildInvisibleWatermarkText(req, projectId) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  return [
    'LUMIA Internal Invisible Watermark',
    `User ID: ${userId || 'anonymous'}`,
    `Project ID: ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
  ].join(' | ')
}

async function streamWatermarkedPdf(inputStream, res, watermarkRequest) {
  const tmpDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ol-user-watermark-'))
  const inputPdfPath = Path.join(tmpDir, 'input.pdf')
  const overlayTexPath = Path.join(tmpDir, 'watermark.tex')
  const overlayPdfPath = Path.join(tmpDir, 'watermark.pdf')
  const overlayedPdfPath = Path.join(tmpDir, 'overlayed.pdf')
  const watermarkJsonPath = Path.join(tmpDir, 'watermark.json')
  const updatedWatermarkJsonPath = Path.join(tmpDir, 'watermark-updated.json')
  const outputPdfPath = Path.join(tmpDir, 'output.pdf')

  try {
    await pipeline(inputStream, createWriteStream(inputPdfPath))
    const pageSize = await getFirstPageSize(inputPdfPath)
    await fs.writeFile(
      overlayTexPath,
      buildWatermarkTex(pageSize, watermarkRequest.lines),
      'utf8'
    )
    await execFileAsync(
      'pdflatex',
      ['-interaction=nonstopmode', '-halt-on-error', 'watermark.tex'],
      {
        cwd: tmpDir,
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT_BUFFER_BYTES,
      }
    )
    await execQpdfAsync(
      [
        '--overlay',
        overlayPdfPath,
        '--repeat=1',
        '--',
        inputPdfPath,
        overlayedPdfPath,
      ],
      {
        cwd: tmpDir,
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT_BUFFER_BYTES,
      },
      'qpdf overlay completed with warnings for PDF watermark'
    )

    try {
      await addHiddenWatermarkAnnotations({
        sourcePdfPath: overlayedPdfPath,
        outputPdfPath,
        markerText: watermarkRequest.invisibleText,
        inputJsonPath: watermarkJsonPath,
        outputJsonPath: updatedWatermarkJsonPath,
      })
    } catch (err) {
      logger.warn(
        { err },
        'failed to add hidden PDF watermark annotations; using visible watermark only'
      )
      await fs.copyFile(overlayedPdfPath, outputPdfPath)
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.writeHead(200)
    await pipeline(createReadStream(outputPdfPath), res)
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(err => {
      logger.warn({ err, tmpDir }, 'failed to clean up PDF watermark temp dir')
    })
  }
}

async function execQpdfAsync(args, options, warningMessage) {
  try {
    return await execFileAsync('qpdf', args, options)
  } catch (err) {
    if (err && err.code === QPDF_EXIT_CODE_WARNINGS) {
      logger.warn({ err }, warningMessage || 'qpdf completed with warnings')
      return { stdout: err.stdout || '', stderr: err.stderr || '' }
    }

    throw err
  }
}

async function getFirstPageSize(pdfPath) {
  try {
    const { stdout } = await execFileAsync(
      'pdfinfo',
      ['-f', '1', '-l', '1', pdfPath],
      {
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT_BUFFER_BYTES,
      }
    )
    const match = stdout.match(
      /^Page\s+(?:\d+\s+)?size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/m
    )
    if (match) {
      const width = Number.parseFloat(match[1])
      const height = Number.parseFloat(match[2])
      if (isUsablePageDimension(width) && isUsablePageDimension(height)) {
        return { width, height }
      }
    }
    logger.warn({ pdfPath }, 'could not parse PDF page size for watermark')
  } catch (err) {
    logger.warn({ err, pdfPath }, 'failed to inspect PDF page size')
  }
  return DEFAULT_PAGE_SIZE
}

function isUsablePageDimension(value) {
  return Number.isFinite(value) && value > 0 && value < 10000
}

function buildWatermarkTex(pageSize, lines) {
  const escapedLines = lines.map(escapeLatex)
  const nodeText = escapedLines.join('\\\\')
  const nodes = buildVisibleWatermarkNodes(pageSize, nodeText)

  return [
    '\\documentclass{article}',
    `\\usepackage[paperwidth=${formatBp(pageSize.width)}bp,paperheight=${formatBp(
      pageSize.height
    )}bp,margin=0bp]{geometry}`,
    '\\usepackage{tikz}',
    '\\usepackage{xcolor}',
    '\\pagestyle{empty}',
    '\\begin{document}',
    '\\noindent\\begin{tikzpicture}[remember picture,overlay]',
    nodes.join('\n'),
    '\\end{tikzpicture}',
    '\\end{document}',
    '',
  ].join('\n')
}

function buildVisibleWatermarkNodes(pageSize, nodeText) {
  const nodes = []
  const stepX = Math.max(260, pageSize.width / 2)
  const stepY = 140
  for (let y = -pageSize.height; y < pageSize.height * 2; y += stepY) {
    for (let x = -pageSize.width; x < pageSize.width * 2; x += stepX) {
      nodes.push(
        `\\node[rotate=35,align=center,text opacity=0.13,text=black,font=\\sffamily\\bfseries\\fontsize{14}{16}\\selectfont] at ([xshift=${formatBp(
          x
        )}bp,yshift=${formatBp(y)}bp]current page.south west) {${nodeText}};`
      )
    }
  }
  return nodes
}

async function addHiddenWatermarkAnnotations({
  sourcePdfPath,
  outputPdfPath,
  markerText,
  inputJsonPath,
  outputJsonPath,
}) {
  if (!markerText) {
    await fs.copyFile(sourcePdfPath, outputPdfPath)
    return
  }

  await execQpdfAsync(
    [
      '--json-output',
      '--json-stream-data=none',
      '--json-key=qpdf',
      '--json-key=pages',
      sourcePdfPath,
      inputJsonPath,
    ],
    {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_OUTPUT_BUFFER_BYTES,
    },
    'qpdf JSON export completed with warnings for hidden PDF watermark'
  )

  const qpdfJson = JSON.parse(await fs.readFile(inputJsonPath, 'utf8'))
  addHiddenAnnotationsToQpdfJson(qpdfJson, markerText)
  await fs.writeFile(outputJsonPath, JSON.stringify(qpdfJson), 'utf8')

  await execQpdfAsync(
    [sourcePdfPath, outputPdfPath, `--update-from-json=${outputJsonPath}`],
    {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_OUTPUT_BUFFER_BYTES,
    },
    'qpdf JSON update completed with warnings for hidden PDF watermark'
  )
}

function addHiddenAnnotationsToQpdfJson(qpdfJson, markerText) {
  const qpdf = qpdfJson && qpdfJson.qpdf
  if (!Array.isArray(qpdf) || !qpdf[0] || !qpdf[1]) {
    throw new Error('unexpected qpdf JSON structure')
  }

  const metadata = qpdf[0]
  const objects = qpdf[1]
  const pages = getOrderedPages(qpdfJson, objects)
  let nextObjectId = getNextObjectId(metadata, objects)
  let addedAnnotations = 0

  for (const page of pages) {
    const pageRef = page.object
    const pageObject = getPdfObject(objects, pageRef)
    const pageValue = pageObject && pageObject.value
    if (!pageValue || pageValue['/Type'] !== '/Page') {
      continue
    }

    const pageNumber = getPageNumber(page, addedAnnotations)
    const annotationRef = `${nextObjectId} 0 R`
    nextObjectId += 1
    objects[getObjectKey(annotationRef)] = {
      value: buildHiddenWatermarkAnnotation(markerText, pageNumber, pageRef),
    }
    appendAnnotationRef(objects, pageValue, annotationRef)
    addedAnnotations += 1
  }

  if (addedAnnotations === 0) {
    throw new Error('could not find PDF page objects for hidden watermark')
  }

  metadata.maxobjectid = nextObjectId - 1
}

function getOrderedPages(qpdfJson, objects) {
  if (Array.isArray(qpdfJson.pages)) {
    return qpdfJson.pages.slice().sort(compareQpdfPages)
  }

  return Object.keys(objects)
    .filter(key => {
      const object = objects[key]
      const value = object && object.value
      return value && value['/Type'] === '/Page'
    })
    .sort(compareObjectKeys)
    .map((key, index) => ({
      object: key.replace(/^obj:/, ''),
      pageposfrom1: index + 1,
    }))
}

function getPageNumber(page, zeroBasedFallback) {
  const pageNumber = Number(page.pageposfrom1)
  if (Number.isFinite(pageNumber)) {
    return pageNumber
  }

  return zeroBasedFallback + 1
}

function compareQpdfPages(left, right) {
  const leftPage = Number(left.pageposfrom1)
  const rightPage = Number(right.pageposfrom1)
  if (Number.isFinite(leftPage) && Number.isFinite(rightPage)) {
    return leftPage - rightPage
  }
  return compareObjectRefs(left.object, right.object)
}

function compareObjectKeys(left, right) {
  return compareObjectRefs(left.replace(/^obj:/, ''), right.replace(/^obj:/, ''))
}

function compareObjectRefs(left, right) {
  return getObjectId(left) - getObjectId(right)
}

function getObjectId(ref) {
  const match = String(ref).match(/^(\d+)\s+\d+\s+R$/)
  return match ? Number.parseInt(match[1], 10) : 0
}

function getNextObjectId(metadata, objects) {
  let maxObjectId = Number(metadata.maxobjectid)
  if (!Number.isFinite(maxObjectId)) {
    maxObjectId = 0
  }

  for (const key of Object.keys(objects)) {
    const objectId = getObjectId(key.replace(/^obj:/, ''))
    if (objectId > maxObjectId) {
      maxObjectId = objectId
    }
  }
  return maxObjectId + 1
}

function getPdfObject(objects, ref) {
  return objects[getObjectKey(ref)]
}

function getObjectKey(ref) {
  return `obj:${ref}`
}

function buildHiddenWatermarkAnnotation(markerText, pageNumber, pageRef) {
  return {
    '/Type': '/Annot',
    '/Subtype': '/Text',
    '/Rect': [0, 0, 0, 0],
    '/F': HIDDEN_WATERMARK_ANNOTATION_FLAGS,
    '/Name': '/Comment',
    '/P': pageRef,
    '/T': 'u:LUMIA Internal',
    '/NM': `u:lumia-hidden-watermark-page-${pageNumber}`,
    '/Contents': `u:${markerText} | Page: ${pageNumber}`,
  }
}

function appendAnnotationRef(objects, pageValue, annotationRef) {
  const annots = pageValue['/Annots']
  if (!annots) {
    pageValue['/Annots'] = [annotationRef]
    return
  }

  if (Array.isArray(annots)) {
    annots.push(annotationRef)
    return
  }

  if (typeof annots === 'string') {
    const annotsObject = getPdfObject(objects, annots)
    const annotsValue = annotsObject && annotsObject.value
    if (Array.isArray(annotsValue)) {
      annotsValue.push(annotationRef)
      return
    }
    pageValue['/Annots'] = [annots, annotationRef]
    return
  }

  pageValue['/Annots'] = [annotationRef]
}

function escapeLatex(value) {
  return String(value).replace(/[\\{}$&#_%~^]/g, character => {
    switch (character) {
      case '\\':
        return '\\textbackslash{}'
      case '{':
        return '\\{'
      case '}':
        return '\\}'
      case '$':
        return '\\$'
      case '&':
        return '\\&'
      case '#':
        return '\\#'
      case '_':
        return '\\_'
      case '%':
        return '\\%'
      case '~':
        return '\\textasciitilde{}'
      case '^':
        return '\\textasciicircum{}'
    }

    return character
  })
}

function formatBp(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, '')
}

const UserWatermarkManager = {
  isEnabledForProject,
  getCompileResponseData,
  getPdfWatermarkRequest,
  streamWatermarkedPdf,
}

export default {
  promises: UserWatermarkManager,
}
