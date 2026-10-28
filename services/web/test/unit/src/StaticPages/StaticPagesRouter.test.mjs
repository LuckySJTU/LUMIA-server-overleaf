import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('StaticPagesRouter community support page', () => {
  let router, webRouter, authentication

  beforeEach(async () => {
    vi.resetModules()
    webRouter = { get: vi.fn() }
    authentication = { addEndpointToLoginWhitelist: vi.fn() }
    vi.doMock(
      '../../../../app/src/Features/StaticPages/HomeController.mjs',
      () => ({
        default: { index: vi.fn(), home: vi.fn(), externalPage: vi.fn() },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/StaticPages/UniversityController.mjs',
      () => ({
        default: { getIndexPage: vi.fn(), getPage: vi.fn() },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Authentication/AuthenticationController.mjs',
      () => ({
        default: authentication,
      })
    )
    router = (
      await import(
        '../../../../app/src/Features/StaticPages/StaticPagesRouter.mjs'
      )
    ).default
    router.apply(webRouter)
  })

  it('allows the support page to be viewed without signing in', () => {
    expect(
      authentication.addEndpointToLoginWhitelist
    ).toHaveBeenCalledWith('/support')
  })

  it('renders the support page with the shared footer', () => {
    const render = vi.fn()
    const route = webRouter.get.mock.calls.find(
      ([path]) => path === '/support'
    )
    expect(route).toHaveLength(2)
    route[1]({}, { render })
    expect(render).toHaveBeenCalledWith('general/support', {
      title: 'Support LUMIA operations',
      showThinFooter: true,
    })
  })

  it('keeps the existing open-source page public and unchanged', () => {
    const render = vi.fn()
    const route = webRouter.get.mock.calls.find(
      ([path]) => path === '/open-source'
    )
    route[1]({}, { render })
    expect(
      authentication.addEndpointToLoginWhitelist
    ).toHaveBeenCalledWith('/open-source')
    expect(render).toHaveBeenCalledWith('general/open-source', {
      title: 'Open Source Notice',
    })
  })
})
