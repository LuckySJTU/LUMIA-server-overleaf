import { createRequire } from 'node:module'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import EmailHelper from '../../../../app/src/Features/Helpers/EmailHelper.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../../../../app/src/Features/User/UserUpdater.mjs'

const require = createRequire(import.meta.url)

function validateSettings() {
  if (!Settings.ldap?.enable) {
    return
  }

  const missing = [
    ['OVERLEAF_LDAP_URL', Settings.ldap.url],
    ['OVERLEAF_LDAP_SEARCH_BASE', Settings.ldap.searchBase],
    ['OVERLEAF_LDAP_BIND_DN', Settings.ldap.bindDn],
    ['OVERLEAF_LDAP_BIND_CREDENTIALS', Settings.ldap.bindCredentials],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(
      `LDAP auth is enabled but missing required settings: ${missing.join(', ')}`
    )
  }
}

function getAttrValue(record, attrName) {
  if (!record || !attrName) {
    return undefined
  }

  const rawValue = record[attrName]
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').trim()
  }
  if (typeof value === 'string') {
    return value.trim()
  }
  if (value == null) {
    return undefined
  }

  return String(value).trim()
}

function isChineseRequest(req) {
  return req.i18n?.language?.toLowerCase().startsWith('zh')
}

function buildFailure(req, englishText, chineseText, status = 403) {
  return {
    status,
    type: 'error',
    text: isChineseRequest(req) ? chineseText : englishText,
  }
}

function splitDisplayName(displayName) {
  if (!displayName) {
    return {}
  }

  const parts = displayName.split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return {}
  }
  if (parts.length === 1) {
    return { firstName: parts[0] }
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  }
}

function buildNameUpdate(ldapUser, user) {
  const displayName = getAttrValue(ldapUser, Settings.ldap.nameAtt)
  const splitName = splitDisplayName(displayName)
  const firstName =
    getAttrValue(ldapUser, Settings.ldap.firstNameAtt) || splitName.firstName
  const lastName =
    getAttrValue(ldapUser, Settings.ldap.lastNameAtt) || splitName.lastName

  const update = {}
  if (firstName && firstName !== user.first_name) {
    update.first_name = firstName
  }
  if (lastName && lastName !== user.last_name) {
    update.last_name = lastName
  }
  return update
}

function isLdapAdmin(ldapUser) {
  if (!Settings.ldap?.isAdminAtt) {
    return false
  }

  const adminValue = getAttrValue(ldapUser, Settings.ldap.isAdminAtt)
  if (!adminValue) {
    return false
  }

  if (!Settings.ldap.isAdminAttValue) {
    return true
  }

  return adminValue === Settings.ldap.isAdminAttValue
}

function getSearchAttributes() {
  return [
    Settings.ldap.emailAtt,
    Settings.ldap.nameAtt,
    Settings.ldap.firstNameAtt,
    Settings.ldap.lastNameAtt,
    Settings.ldap.uidAtt,
    Settings.ldap.isAdminAtt,
  ].filter(Boolean)
}

function buildOverleafEmail(ldapUser) {
  if (Settings.ldap.overleafEmailDomain) {
    const uid = getAttrValue(ldapUser, Settings.ldap.uidAtt)
    if (!uid) {
      return null
    }
    return EmailHelper.parseEmail(
      `${uid}@${Settings.ldap.overleafEmailDomain}`
    )
  }

  const ldapEmail = getAttrValue(ldapUser, Settings.ldap.emailAtt)
  return EmailHelper.parseEmail(ldapEmail)
}

async function resolveUserFromLdap(req, ldapUser) {
  const email = buildOverleafEmail(ldapUser)

  if (!email) {
    logger.warn(
      {
        uid: getAttrValue(ldapUser, Settings.ldap.uidAtt),
        ldapEmail: getAttrValue(ldapUser, Settings.ldap.emailAtt),
        overleafEmailDomain: Settings.ldap.overleafEmailDomain,
      },
      'LDAP login rejected because no Overleaf lookup email could be derived'
    )
    return {
      user: false,
      info: buildFailure(
        req,
        Settings.ldap.overleafEmailDomain
          ? 'Your LDAP account is missing a uid required for Overleaf login. Contact an administrator.'
          : 'Your LDAP account is missing an email address. Contact an administrator.',
        Settings.ldap.overleafEmailDomain
          ? 'LDAP 账户缺少用于生成 Overleaf 邮箱的 uid，无法登录，请联系管理员。'
          : 'LDAP 账户没有可用邮箱，无法登录，请联系管理员。'
      ),
    }
  }

  let user = await UserGetter.promises.getUserByAnyEmail(email)
  if (!user) {
    logger.warn({ email }, 'LDAP login rejected for unprovisioned user')
    return {
      user: false,
      info: buildFailure(
        req,
        'Your account has not been provisioned in Overleaf. Contact an administrator.',
        '该账号尚未在 Overleaf 中预置，无法登录，请联系管理员。'
      ),
    }
  }

  const update = {}

  if (user.holdingAccount) {
    update.holdingAccount = false
  }

  if (Settings.ldap.updateUserDetailsOnLogin) {
    Object.assign(update, buildNameUpdate(ldapUser, user))
  }

  if (isLdapAdmin(ldapUser) && !user.isAdmin) {
    update.isAdmin = true
  }

  if (Object.keys(update).length > 0) {
    await UserUpdater.promises.updateUser(user._id, { $set: update })
    user = await UserGetter.promises.getUser(user._id)
  }

  return { user }
}

async function passportSetup(passport) {
  if (!Settings.ldap?.enable) {
    return
  }

  const passportLdapAuth = require('passport-ldapauth')
  const LdapStrategy = passportLdapAuth.Strategy || passportLdapAuth

  passport.use(
    'ldap',
    new LdapStrategy(
      {
        server: {
          url: Settings.ldap.url,
          bindDn: Settings.ldap.bindDn,
          bindCredentials: Settings.ldap.bindCredentials,
          searchBase: Settings.ldap.searchBase,
          searchFilter: Settings.ldap.searchFilter,
          searchAttributes: getSearchAttributes(),
        },
        usernameField: 'username',
        passwordField: 'password',
        passReqToCallback: true,
        handleErrorsAsFailures: true,
      },
      (req, ldapUser, done) => {
        resolveUserFromLdap(req, ldapUser)
          .then(({ user, info }) => done(null, user, info))
          .catch(error => done(error))
      }
    )
  )

  logger.info(
    {
      url: Settings.ldap.url,
      searchBase: Settings.ldap.searchBase,
      searchFilter: Settings.ldap.searchFilter,
    },
    'registered LDAP passport strategy'
  )
}

export default {
  validateSettings,
  passportSetup,
  promises: {
    passportSetup,
  },
}
