import { lazy, memo } from 'react'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import { useProjectContext } from '@/shared/context/project-context'

const PdfJsViewer = lazy(
  () => import(/* webpackChunkName: "pdf-js-viewer" */ './pdf-js-viewer')
)

function PdfViewer() {
  const { pdfUrl, pdfFile, pdfViewer } = useCompileContext()
  const { project } = useProjectContext()
  const viewerUrl =
    project?.userWatermarkEnabled && pdfFile?.pdfDownloadUrl
      ? buildInlinePdfUrl(pdfFile.pdfDownloadUrl)
      : pdfUrl

  if (!viewerUrl) {
    return null
  }

  switch (pdfViewer) {
    case 'native':
      return <iframe title="PDF Preview" src={viewerUrl} />

    case 'pdfjs':
    default:
      return <PdfJsViewer url={viewerUrl} pdfFile={pdfFile} />
  }
}

function buildInlinePdfUrl(downloadUrl: string) {
  const url = new URL(downloadUrl, window.location.origin)
  url.searchParams.delete('popupDownload')
  return url.toString()
}

export default memo(PdfViewer)
