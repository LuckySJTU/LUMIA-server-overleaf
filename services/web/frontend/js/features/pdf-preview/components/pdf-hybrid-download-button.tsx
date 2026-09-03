import { useTranslation } from 'react-i18next'
import { useDetachCompileContext as useCompileContext } from '../../../shared/context/detach-compile-context'
import { useProjectContext } from '@/shared/context/project-context'
import { isSmallDevice } from '@/infrastructure/event-tracking'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import { useEditorAnalytics } from '@/shared/hooks/use-editor-analytics'

function PdfHybridDownloadButton() {
  const { pdfDownloadUrl, pdfUnwatermarkedDownloadUrl } = useCompileContext()
  const { sendEvent } = useEditorAnalytics()

  const { projectId, project } = useProjectContext()
  const activeUnwatermarkedDownloadUrl = project?.userWatermarkEnabled
    ? pdfUnwatermarkedDownloadUrl
    : undefined

  const { t } = useTranslation()
  const description = pdfDownloadUrl
    ? t('download_pdf')
    : t('please_compile_pdf_before_download')
  const unwatermarkedDescription = activeUnwatermarkedDownloadUrl
    ? t('download_pdf_without_watermark')
    : t('please_compile_pdf_before_download')

  function handleOnClick(e: React.MouseEvent, withoutWatermark = false) {
    const event = e as React.MouseEvent<HTMLAnchorElement>
    if (event.currentTarget.dataset.disabled === 'true') {
      event.preventDefault()
      return
    }

    sendEvent('download-pdf-button-click', {
      projectId,
      location: 'pdf-preview',
      isSmallDevice,
      withoutWatermark,
    })
  }

  return (
    <>
      <OLTooltip
        id="download-pdf"
        description={description}
        overlayProps={{ placement: 'bottom' }}
      >
        <OLButton
          onClick={handleOnClick}
          variant="link"
          className="pdf-toolbar-btn"
          draggable={false}
          data-disabled={!pdfDownloadUrl}
          disabled={!pdfDownloadUrl}
          download
          href={pdfDownloadUrl || '#'}
          target="_blank"
          style={{ pointerEvents: 'auto' }}
          aria-label={t('download_pdf')}
        >
          <MaterialIcon type="download" />
        </OLButton>
      </OLTooltip>
      {activeUnwatermarkedDownloadUrl && (
        <OLTooltip
          id="download-pdf-without-watermark"
          description={unwatermarkedDescription}
          overlayProps={{ placement: 'bottom' }}
        >
          <OLButton
            onClick={e => handleOnClick(e, true)}
            variant="link"
            className="pdf-toolbar-btn"
            draggable={false}
            data-disabled={!activeUnwatermarkedDownloadUrl}
            disabled={!activeUnwatermarkedDownloadUrl}
            download
            href={activeUnwatermarkedDownloadUrl || '#'}
            target="_blank"
            style={{ pointerEvents: 'auto' }}
            aria-label={t('download_pdf_without_watermark')}
          >
            <MaterialIcon type="download" />
          </OLButton>
        </OLTooltip>
      )}
    </>
  )
}

export default PdfHybridDownloadButton
