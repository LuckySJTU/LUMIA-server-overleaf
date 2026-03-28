import parseArgs from 'minimist'
import EmailHelper from '../app/src/Features/Helpers/EmailHelper.mjs'
import UserCreator from '../app/src/Features/User/UserCreator.mjs'
import UserGetter from '../app/src/Features/User/UserGetter.mjs'
import UserUpdater from '../app/src/Features/User/UserUpdater.mjs'
import { scriptRunner } from './lib/ScriptRunner.mjs'

const argv = parseArgs(process.argv.slice(2), {
  string: ['email', 'first-name', 'last-name'],
  boolean: ['admin'],
})

function usage() {
  console.error(
    'Usage: node scripts/provision_ldap_user.mjs --email=<email> [--first-name=<name>] [--last-name=<name>] [--admin]'
  )
}

async function main() {
  const email = EmailHelper.parseEmail(argv.email)
  if (!email) {
    usage()
    throw new Error('a valid --email is required')
  }

  let user = await UserGetter.promises.getUserByAnyEmail(email)

  if (!user) {
    user = await UserCreator.promises.createNewUser(
      {
        email,
        first_name: argv['first-name'] || email.split('@')[0],
        last_name: argv['last-name'] || '',
        holdingAccount: false,
        isAdmin: argv.admin === true,
      },
      { confirmedAt: new Date() }
    )

    console.log(
      JSON.stringify(
        {
          action: 'created',
          email: user.email,
          userId: user._id.toString(),
          isAdmin: Boolean(user.isAdmin),
        },
        null,
        2
      )
    )
    return
  }

  const update = { $set: {} }

  if (user.holdingAccount) {
    update.$set.holdingAccount = false
  }
  if (argv['first-name']) {
    update.$set.first_name = argv['first-name']
  }
  if (argv['last-name']) {
    update.$set.last_name = argv['last-name']
  }
  if (argv.admin === true && !user.isAdmin) {
    update.$set.isAdmin = true
  }

  if (Object.keys(update.$set).length > 0) {
    await UserUpdater.promises.updateUser(user._id, update)
    user = await UserGetter.promises.getUser(user._id)
  }

  console.log(
    JSON.stringify(
      {
        action: 'updated',
        email: user.email,
        userId: user._id.toString(),
        holdingAccount: Boolean(user.holdingAccount),
        isAdmin: Boolean(user.isAdmin),
      },
      null,
      2
    )
  )
}

try {
  await scriptRunner(main, {
    email: argv.email,
    admin: argv.admin === true,
  })
  process.exit(0)
} catch (error) {
  console.error(error)
  process.exit(1)
}
