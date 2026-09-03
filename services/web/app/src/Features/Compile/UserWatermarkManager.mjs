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

async function streamWatermarkedPdf(inputStream, res, watermarkRequest) {
  const tmpDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'ol-user-watermark-'))
  const inputPdfPath = Path.join(tmpDir, 'input.pdf')
  const overlayTexPath = Path.join(tmpDir, 'watermark.tex')
  const overlayPdfPath = Path.join(tmpDir, 'watermark.pdf')
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
    await execFileAsync(
      'qpdf',
      [
        '--overlay',
        overlayPdfPath,
        '--repeat=1',
        '--',
        inputPdfPath,
        outputPdfPath,
      ],
      {
        cwd: tmpDir,
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT_BUFFER_BYTES,
      }
    )

    res.setHeader('Content-Type', 'application/pdf')
    res.writeHead(200)
    await pipeline(createReadStream(outputPdfPath), res)
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(err => {
      logger.warn({ err, tmpDir }, 'failed to clean up PDF watermark temp dir')
    })
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
  const nodes = buildWatermarkNodes(pageSize, nodeText)

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

function buildWatermarkNodes(pageSize, nodeText) {
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
