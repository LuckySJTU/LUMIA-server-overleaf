import { RateLimiter } from '../../infrastructure/RateLimiter.mjs'
import { callbackify } from '@overleaf/promise-utils'
import Settings from '@overleaf/settings'

const rateLimiterLoginEmail = new RateLimiter(
  'login',
  Settings.rateLimit?.login?.email || {
    points: 10,
    duration: 120,
  }
)

function normalizeLoginIdentifier(identifier) {
  if (typeof identifier !== 'string') {
    return ''
  }
  return identifier.trim().toLowerCase()
}

async function processLoginRequest(identifier) {
  identifier = normalizeLoginIdentifier(identifier)
  if (!identifier) {
    return true
  }
  try {
    await rateLimiterLoginEmail.consume(identifier, 1, {
      method: 'email',
    })
    return true
  } catch (err) {
    if (err instanceof Error) {
      throw err
    } else {
      return false
    }
  }
}

async function recordSuccessfulLogin(identifier) {
  identifier = normalizeLoginIdentifier(identifier)
  if (!identifier) {
    return
  }
  await rateLimiterLoginEmail.delete(identifier)
}

const LoginRateLimiter = {
  processLoginRequest: callbackify(processLoginRequest),
  recordSuccessfulLogin: callbackify(recordSuccessfulLogin),
}
LoginRateLimiter.promises = {
  processLoginRequest,
  recordSuccessfulLogin,
}

export default LoginRateLimiter
