import { OLModal } from '@/shared/components/ol/ol-modal'
import ModalContentNewProjectForm from './modal-content-new-project-form'

type InternalDefaultProjectModalProps = {
  onHide: () => void
}

function InternalDefaultProjectModal({
  onHide,
}: InternalDefaultProjectModalProps) {
  return (
    <OLModal
      show
      animation
      onHide={onHide}
      id="internal-default-project-modal"
      backdrop="static"
    >
      <ModalContentNewProjectForm onCancel={onHide} template="lumia-default" />
    </OLModal>
  )
}

export default InternalDefaultProjectModal
