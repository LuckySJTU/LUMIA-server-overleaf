import { createRequire } from 'node:module'
import parseArgs from 'minimist'
import Settings from '@overleaf/settings'
import EmailHelper from '../app/src/Features/Helpers/EmailHelper.mjs'
import UserCreator from '../app/src/Features/User/UserCreator.mjs'
import UserGetter from '../app/src/Features/User/UserGetter.mjs'
import { scriptRunner } from './lib/ScriptRunner.mjs'

const require = createRequire(import.meta.url)

function loadLdapLibrary() {
  try {
    return require('ldapjs')
  } catch (error) {
    return require('ldapauth-fork/node_modules/ldapjs')
  }
}

const ldap = loadLdapLibrary()

const argv = parseArgs(process.argv.slice(2), {
  string: [
    'url',
    'bind-dn',
    'bind-credentials',
    'search-base',
    'filter',
    'uid-attr',
    'cn-attr',
    'email-domain',
  ],
  boolean: ['dry-run'],
  default: {
    'dry-run': false,
  },
})

function usage() {
  console.error(
    'Usage: node scripts/sync_ldap_users_to_overleaf.mjs [--dry-run] [--url=ldap://192.168.102.101:389] [--bind-dn=cn=admin,dc=sugon,dc=com] [--bind-credentials=...] [--search-base=ou=People,dc=sugon,dc=com] [--filter=(&(uid=*)(cn=*))] [--uid-attr=uid] [--cn-attr=cn] [--email-domain=lumia.cn]'
  )
}

function getConfig() {
  return {
    url:
      argv.url ||
      Settings.ldap?.url ||
      process.env.OVERLEAF_LDAP_URL ||
      'ldap://192.168.102.101:389',
    bindDn:
      argv['bind-dn'] ||
      Settings.ldap?.bindDn ||
      process.env.OVERLEAF_LDAP_BIND_DN ||
      'cn=admin,dc=sugon,dc=com',
    bindCredentials:
      argv['bind-credentials'] ||
      Settings.ldap?.bindCredentials ||
      process.env.OVERLEAF_LDAP_BIND_CREDENTIALS,
    searchBase:
      argv['search-base'] ||
      Settings.ldap?.searchBase ||
      process.env.OVERLEAF_LDAP_SEARCH_BASE ||
      'ou=People,dc=sugon,dc=com',
    uidAttr:
      argv['uid-attr'] ||
      Settings.ldap?.uidAtt ||
      process.env.OVERLEAF_LDAP_UID_ATT ||
      'uid',
    cnAttr:
      argv['cn-attr'] ||
      Settings.ldap?.nameAtt ||
      process.env.OVERLEAF_LDAP_NAME_ATT ||
      'cn',
    emailDomain:
      argv['email-domain'] ||
      Settings.ldap?.overleafEmailDomain ||
      process.env.OVERLEAF_LDAP_OVERLEAF_EMAIL_DOMAIN ||
      'lumia.cn',
    filter:
      argv.filter ||
      `(&(${argv['uid-attr'] || Settings.ldap?.uidAtt || process.env.OVERLEAF_LDAP_UID_ATT || 'uid'}=*)(${argv['cn-attr'] || Settings.ldap?.nameAtt || process.env.OVERLEAF_LDAP_NAME_ATT || 'cn'}=*))`,
    dryRun: argv['dry-run'] === true,
  }
}

function validateConfig(config) {
  const missing = ['bindCredentials'].filter(key => !config[key])
  if (missing.length > 0) {
    usage()
    throw new Error(`Missing required configuration: ${missing.join(', ')}`)
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

function createClient(config) {
  return ldap.createClient({
    url: config.url,
    reconnect: false,
    timeout: 30000,
    connectTimeout: 30000,
  })
}

function bind(client, bindDn, bindCredentials) {
  return new Promise((resolve, reject) => {
    client.bind(bindDn, bindCredentials, err => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

function unbind(client) {
  return new Promise(resolve => {
    client.unbind(() => resolve())
  })
}

function searchEntries(client, config) {
  return new Promise((resolve, reject) => {
    const entries = []
    client.search(
      config.searchBase,
      {
        scope: 'sub',
        filter: config.filter,
        attributes: [config.uidAttr, config.cnAttr],
        paged: true,
      },
      (err, res) => {
        if (err) {
          return reject(err)
        }

        res.on('searchEntry', entry => {
          entries.push(entry.object)
        })
        res.on('error', reject)
        res.on('end', result => {
          if (result?.status !== 0) {
            return reject(
              new Error(`LDAP search ended with status ${result.status}`)
            )
          }
          resolve(entries)
        })
      }
    )
  })
}

function buildOverleafUser(entry, config) {
  const uid = getAttrValue(entry, config.uidAttr)
  const cn = getAttrValue(entry, config.cnAttr)

  if (!uid || !cn) {
    return null
  }

  const email = EmailHelper.parseEmail(`${uid}@${config.emailDomain}`)
  if (!email) {
    return null
  }

  return {
    uid,
    cn,
    email,
  }
}

async function createOverleafUser(user) {
  return await UserCreator.promises.createNewUser(
    {
      email: user.email,
      first_name: user.cn,
      last_name: '',
      holdingAccount: false,
    },
    { confirmedAt: new Date() }
  )
}

async function main(trackProgress) {
  const config = getConfig()
  validateConfig(config)

  const client = createClient(config)
  const summary = {
    ldapEntries: 0,
    validEntries: 0,
    skippedExisting: 0,
    created: 0,
    invalidEntries: 0,
    dryRun: config.dryRun,
  }

  try {
    await bind(client, config.bindDn, config.bindCredentials)
    const rawEntries = await searchEntries(client, config)
    summary.ldapEntries = rawEntries.length

    const seenEmails = new Set()

    for (const entry of rawEntries) {
      const user = buildOverleafUser(entry, config)
      if (!user) {
        summary.invalidEntries += 1
        continue
      }

      if (seenEmails.has(user.email)) {
        continue
      }
      seenEmails.add(user.email)
      summary.validEntries += 1

      const existing = await UserGetter.promises.getUserByAnyEmail(user.email)
      if (existing) {
        summary.skippedExisting += 1
        continue
      }

      if (config.dryRun) {
        summary.created += 1
        console.log(
          JSON.stringify(
            { action: 'would-create', email: user.email, cn: user.cn, uid: user.uid },
            null,
            2
          )
        )
        continue
      }

      const createdUser = await createOverleafUser(user)
      summary.created += 1
      await trackProgress(`created ${createdUser.email}`)
      console.log(
        JSON.stringify(
          {
            action: 'created',
            email: createdUser.email,
            userId: createdUser._id.toString(),
            cn: user.cn,
            uid: user.uid,
          },
          null,
          2
        )
      )
    }
  } finally {
    await unbind(client)
  }

  console.log(JSON.stringify(summary, null, 2))
}

try {
  await scriptRunner(main, {
    dryRun: argv['dry-run'] === true,
  })
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}
