import { memo, useMemo } from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import { useUserContext } from '@/shared/context/user-context'

const WATERMARK_COUNT = 176

function UserWatermarkOverlay() {
  const { project } = useProjectContext()
  const user = useUserContext()
  const items = useMemo(
    () => Array.from({ length: WATERMARK_COUNT }, (_, index) => index),
    []
  )

  if (!project?.userWatermarkEnabled) {
    return null
  }

  const userId = user.id || 'anonymous'
  const watermarkText = `LUMIA Internal - User ID: ${userId}`

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        pointerEvents: 'none',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: '-36vw',
          top: '-36vh',
          width: '172vw',
          height: '172vh',
          display: 'grid',
          gridTemplateColumns: 'repeat(8, minmax(150px, 1fr))',
          gridAutoRows: '72px',
          gap: '18px 28px',
          transform: 'rotate(-26deg)',
          transformOrigin: 'center',
          alignItems: 'center',
          justifyItems: 'center',
        }}
      >
        {items.map(index => (
          <span
            key={index}
            style={{
              width: '260px',
              maxWidth: '42vw',
              color: '#111827',
              fontSize: '13px',
              lineHeight: 1.35,
              fontWeight: 700,
              letterSpacing: 0,
              opacity: 0.13,
              textAlign: 'center',
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
            }}
          >
            {watermarkText}
          </span>
        ))}
      </div>
    </div>
  )
}

export default memo(UserWatermarkOverlay)
