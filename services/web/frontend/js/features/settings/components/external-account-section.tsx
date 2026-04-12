import getMeta from '../../../utils/meta'

function ExternalAccountSection() {
  const user = getMeta('ol-user')
  const isExternalAuthenticationSystemUsed = getMeta(
    'ol-isExternalAuthenticationSystemUsed'
  )

  if (!user?.isAdmin || !isExternalAuthenticationSystemUsed) {
    return null
  }

  return (
    <>
      <hr />
      <h3>External accounts</h3>
      <p>
        Invite users who should sign in with an email address and password
        instead of LDAP. Each invited user receives an activation email and is
        created as an independent account.
      </p>
      <p>
        <a className="btn btn-secondary" href="/admin/external-users">
          Manage external accounts
        </a>
      </p>
    </>
  )
}

export default ExternalAccountSection
