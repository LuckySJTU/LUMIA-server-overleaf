import Settings from '@overleaf/settings'
import LdapAuthIntegration from './app/src/LdapAuthIntegration.mjs'

/**
 * @import { WebModule } from "../../types/web-module"
 */

if (Settings.ldap?.enable) {
  LdapAuthIntegration.validateSettings()
}

/** @type {WebModule} */
const LdapAuthModule = {
  hooks: {
    promises: {
      passportSetup: LdapAuthIntegration.passportSetup,
    },
  },
}

export default LdapAuthModule
