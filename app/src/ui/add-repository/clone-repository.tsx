import { remote } from 'electron'
import * as Path from 'path'
import * as React from 'react'
import * as FS from 'fs'
import { TextBox } from '../lib/text-box'
import { Button } from '../lib/button'
import { ButtonGroup } from '../lib/button-group'
import { Dispatcher } from '../../lib/dispatcher'
import { getDefaultDir, setDefaultDir } from '../lib/default-dir'
import { Row } from '../lib/row'
import { Account } from '../../models/account'
import { parseOwnerAndName, IRepositoryIdentifier } from '../../lib/remote-parsing'
import { findAccountForRemote } from '../../lib/find-account'
import { API } from '../../lib/api'
import { Dialog, DialogContent, DialogError, DialogFooter } from '../dialog'

/** The name for the error when the destination already exists. */
const DestinationExistsErrorName = 'DestinationExistsError'

interface ICloneRepositoryProps {
  readonly dispatcher: Dispatcher
  readonly onDismissed: () => void

  /** The logged in accounts. */
  readonly accounts: ReadonlyArray<Account>
}

interface ICloneRepositoryState {
  /** The user-entered URL or `owner/name` shortcut. */
  readonly url: string

  /** The local path to clone to. */
  readonly path: string

  /** Are we currently trying to load the entered repository? */
  readonly loading: boolean

  /** The current error if one occurred. */
  readonly error: Error | null

  /**
   * The repository identifier that was last parsed from the user-entered URL.
   */
  readonly lastParsedIdentifier: IRepositoryIdentifier | null
}

/** The component for cloning a repository. */
export class CloneRepository extends React.Component<ICloneRepositoryProps, ICloneRepositoryState> {
  public constructor(props: ICloneRepositoryProps) {
    super(props)

    this.state = {
      url: '',
      path: getDefaultDir(),
      loading: false,
      error: null,
      lastParsedIdentifier: null,
    }
  }

  public render() {
    const error = this.state.error
    const disabled =
      this.state.url.length === 0 ||
      this.state.path.length === 0 ||
      this.state.loading ||
      !!error && error.name === DestinationExistsErrorName

    return (
      <Dialog
        className='clone-repository'
        title='Clone a repository'
        onSubmit={this.clone}
        onDismissed={this.props.onDismissed}
        loading={this.state.loading}>
        {error ? <DialogError>{error.message}</DialogError> : null}

        <DialogContent>
          <p>
            Enter a repository URL or GitHub username and repository (e.g., <span className='repository-pattern'>hubot/cool-repo</span>)
          </p>

          <Row>
            <TextBox
              placeholder='URL or username/repository'
              value={this.state.url}
              onValueChanged={this.onURLChanged}
              autoFocus/>
          </Row>

          <Row>
            <TextBox
              value={this.state.path}
              label={__DARWIN__ ? 'Local Path' : 'Local path'}
              placeholder='repository path'
              onChange={this.onPathChanged}/>
            <Button onClick={this.showFilePicker}>Choose…</Button>
          </Row>
        </DialogContent>

        <DialogFooter>
          <ButtonGroup>
            <Button disabled={disabled} type='submit'>Clone</Button>
            <Button onClick={this.props.onDismissed}>Cancel</Button>
          </ButtonGroup>
        </DialogFooter>
      </Dialog>
    )
  }

  private showFilePicker = () => {
    const directory: string[] | null = remote.dialog.showOpenDialog({
      properties: [ 'createDirectory', 'openDirectory' ],
    })
    if (!directory) { return }

    const path = directory[0]
    this.setState({ ...this.state, path })
  }

  private checkPathValid(newPath: string) {
    FS.exists(newPath, exists => {
      // If the path changed while we were checking, we don't care anymore.
      if (this.state.path !== newPath) { return }

      let error: Error | null = null
      if (exists) {
        error = new Error('The destination already exists.')
        error.name = DestinationExistsErrorName
      }

      this.setState({ ...this.state, error })
    })
  }

  private onURLChanged = (input: string) => {
    const url = input
    const parsed = parseOwnerAndName(url)
    const lastParsedIdentifier = this.state.lastParsedIdentifier

    let newPath: string
    if (lastParsedIdentifier) {
      if (parsed) {
        newPath = Path.join(Path.dirname(this.state.path), parsed.name)
      } else {
        newPath = Path.dirname(this.state.path)
      }
    } else if (parsed) {
      newPath = Path.join(this.state.path, parsed.name)
    } else {
      newPath = this.state.path
    }

    this.setState({
      ...this.state,
      url,
      path: newPath,
      lastParsedIdentifier: parsed,
    })

    this.checkPathValid(newPath)
  }

  private onPathChanged = (event: React.FormEvent<HTMLInputElement>) => {
    const path = event.currentTarget.value
    this.setState({ ...this.state, path })
    this.checkPathValid(path)
  }

  /**
   * Lookup the account associated with the clone (if applicable) and resolve
   * the repository alias to the clone URL. findAccountForRemote will throw
   * if neither of these conditions are satisfied, so let this bubble up and
   * display a relevant message to the user.
   */
  private async resolveCloneDetails(): Promise<{ url: string, account: Account | null }> {
    const identifier = this.state.lastParsedIdentifier
    let url = this.state.url

    let account: Account | null
    try {
      account = await findAccountForRemote(url, this.props.accounts)
    } catch (e) {
      account = null
    }

    if (identifier) {
      const api = new API(account || Account.anonymous())
      const repo = await api.fetchRepository(identifier.owner, identifier.name)
      if (repo) {
        url =  repo.cloneUrl
      }
    }

    return { url, account }
  }

  private clone = async () => {
    this.setState({ ...this.state, loading: true })

    const path = this.state.path

    try {
      const { url, account } = await this.resolveCloneDetails()
      this.cloneImpl(url, path, account)
    } catch (error) {
      this.setState({
        ...this.state,
        loading: false,
        error,
      })
    }
  }

  private cloneImpl(url: string, path: string, account: Account | null) {
    this.props.dispatcher.clone(url, path, { account })
    this.props.onDismissed()

    setDefaultDir(Path.resolve(path, '..'))
  }
}
