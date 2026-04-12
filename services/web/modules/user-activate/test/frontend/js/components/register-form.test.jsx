import { expect } from 'chai'
import { render, screen, fireEvent } from '@testing-library/react'
import fetchMock from 'fetch-mock'
import sinon from 'sinon'
import RegisterForm from '../../../../frontend/js/components/register-form'

describe('RegisterForm', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })
  it('should render the register form', async function () {
    const setRegistrationSuccessStub = sinon.stub()
    const setEmailsStub = sinon.stub()
    const setRegisterErrorStub = sinon.stub()
    const setFailedEmailsStub = sinon.stub()

    render(
      <RegisterForm
        setRegistrationSuccess={setRegistrationSuccessStub}
        setEmails={setEmailsStub}
        setRegisterError={setRegisterErrorStub}
        setFailedEmails={setFailedEmailsStub}
      />
    )
    await screen.findByLabelText('Email addresses to invite as external users')
    screen.getByRole('button', { name: /send activation email/i })
  })

  it('should call the fetch request when register button is pressed', async function () {
    const email = 'abc@gmail.com'
    const setRegistrationSuccessStub = sinon.stub()
    const setEmailsStub = sinon.stub()
    const setRegisterErrorStub = sinon.stub()
    const setFailedEmailsStub = sinon.stub()

    const endPointResponse = {
      status: 200,
      body: {
        email,
        setNewPasswordUrl: 'SetNewPasswordURL',
      },
    }
    const registerMock = fetchMock.post(
      '/admin/external-users',
      endPointResponse
    )

    render(
      <RegisterForm
        setRegistrationSuccess={setRegistrationSuccessStub}
        setEmails={setEmailsStub}
        setRegisterError={setRegisterErrorStub}
        setFailedEmails={setFailedEmailsStub}
      />
    )
    const registerInput = screen.getByLabelText(
      'Email addresses to invite as external users'
    )
    const registerButton = screen.getByRole('button', {
      name: /send activation email/i,
    })
    fireEvent.change(registerInput, { target: { value: email } })
    fireEvent.click(registerButton)
    expect(registerMock.callHistory.called()).to.be.true
  })
})
