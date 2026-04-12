import Settings from '@overleaf/settings'
import EmailHelper from '../Helpers/EmailHelper.mjs'

function isLdapManagedUser(user, req) {
  const ldapDomain = Settings.ldap?.overleafEmailDomain

  if (!Settings.ldap?.enable) {
    return false
  }

  if (req?.session?.authProvider === 'ldap') {
    return true
  }

  if (req?.session?.authProvider) {
    return false
  }

  if (!ldapDomain || !user?.email) {
    return false
  }

  const userDomain = EmailHelper.getDomain(user.email)
  return (
    typeof userDomain === 'string' &&
    userDomain.toLowerCase() === ldapDomain.toLowerCase()
  )
}

export default {
  isLdapManagedUser,
}
