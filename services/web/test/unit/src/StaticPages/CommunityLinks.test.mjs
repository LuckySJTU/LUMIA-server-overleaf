import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const settingsPath = require.resolve(
  '../../../../config/settings.defaults.js'
)

function getLinks() {
  delete require.cache[settingsPath]
  return require(settingsPath).nav.left_footer.filter(
    item => item.group === 'lumia-community'
  )
}

describe('LUMIA community links', () => {
  beforeEach(() => {
    vi.stubEnv('OVERLEAF_PERSONAL_WEBSITE_URL', undefined)
    vi.stubEnv('OVERLEAF_OPERATIONS_SUPPORT_URL', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete require.cache[settingsPath]
  })

  it('defaults to the requested profile and the text-only support page', () => {
    expect(getLinks()).toEqual([
      {
        text: 'personal_homepage',
        url: 'https://github.com/LuckySJTU',
        group: 'lumia-community',
        icon: 'person',
        target: '_blank',
      },
      {
        text: 'support_operations',
        url: '/support',
        group: 'lumia-community',
        icon: 'favorite',
        target: '_blank',
      },
    ])
  })

  it('honors server-configured URLs', () => {
    vi.stubEnv(
      'OVERLEAF_PERSONAL_WEBSITE_URL',
      'https://example.com/profile'
    )
    vi.stubEnv('OVERLEAF_OPERATIONS_SUPPORT_URL', '/another-support-page')
    expect(getLinks().map(item => item.url)).toEqual([
      'https://example.com/profile',
      '/another-support-page',
    ])
  })

  it.each([
    ['OVERLEAF_PERSONAL_WEBSITE_URL', '/support'],
    ['OVERLEAF_OPERATIONS_SUPPORT_URL', 'https://github.com/LuckySJTU'],
  ])('hides only the link disabled by %s', (name, remainingUrl) => {
    vi.stubEnv(name, '')
    expect(getLinks().map(item => item.url)).toEqual([remainingUrl])
  })

  it('can disable both links without removing the open-source notice', () => {
    vi.stubEnv('OVERLEAF_PERSONAL_WEBSITE_URL', '')
    vi.stubEnv('OVERLEAF_OPERATIONS_SUPPORT_URL', '')
    expect(getLinks()).toEqual([])
    expect(require(settingsPath).nav.left_footer).toEqual([
      { text: 'Open source notice', url: '/open-source' },
    ])
  })
})
