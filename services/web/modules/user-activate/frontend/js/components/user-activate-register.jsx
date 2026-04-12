import { useState } from 'react'
import PropTypes from 'prop-types'
import RegisterForm from './register-form'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLCard from '@/shared/components/ol/ol-card'
import Notification from '@/shared/components/notification'

function UserActivateRegister() {
  const [emails, setEmails] = useState([])
  const [failedEmails, setFailedEmails] = useState([])
  const [registerError, setRegisterError] = useState(false)
  const [registrationSuccess, setRegistrationSuccess] = useState(false)

  return (
    <OLRow>
      <OLCol>
        <OLCard>
          <div className="page-header">
            <h1>Create external accounts</h1>
          </div>
          <RegisterForm
            setRegistrationSuccess={setRegistrationSuccess}
            setEmails={setEmails}
            setRegisterError={setRegisterError}
            setFailedEmails={setFailedEmails}
          />
          {registerError ? (
            <UserActivateError failedEmails={failedEmails} />
          ) : null}
          {registrationSuccess ? (
            <>
              <SuccessfulRegistrationMessage />
              <hr />
              <DisplayEmailsList emails={emails} />
            </>
          ) : null}
        </OLCard>
      </OLCol>
    </OLRow>
  )
}

function UserActivateError({ failedEmails }) {
  return (
    <div className="row-spaced">
      <Notification
        type="error"
        content="Sorry, an error occurred while creating these external accounts:"
        className="mb-3"
      />
      <ul>
        {failedEmails.map(email => (
          <li key={email}>{email}</li>
        ))}
      </ul>
    </div>
  )
}

function SuccessfulRegistrationMessage() {
  return (
    <div className="row-spaced text-success">
      <p>We've sent activation emails to the external users you invited.</p>
      <p>
        You can also manually send them the activation URLs below so they can
        set a password and log in for the first time.
      </p>
      <p>
        (Activation links expire after one week. After that, send a new
        invitation.)
      </p>
    </div>
  )
}

function DisplayEmailsList({ emails }) {
  return (
    <table className="table table-striped ">
      <tbody>
        <tr>
          <th>Email</th>
          <th>Activation URL</th>
        </tr>
        {emails.map(user => (
          <tr key={user.email}>
            <td>{user.email}</td>
            <td style={{ wordBreak: 'break-all' }}>{user.setNewPasswordUrl}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

DisplayEmailsList.propTypes = {
  emails: PropTypes.array,
}
UserActivateError.propTypes = {
  failedEmails: PropTypes.array,
}

export default UserActivateRegister
