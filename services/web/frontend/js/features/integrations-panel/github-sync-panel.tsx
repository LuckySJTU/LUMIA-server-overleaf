import { useCallback, useEffect, useState } from 'react'
import { deleteJSON, getJSON, postJSON } from '@/infrastructure/fetch-json'
import type { FetchError } from '@/infrastructure/fetch-json'
import { useProjectContext } from '@/shared/context/project-context'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'

type GitHubSyncState = {
  linked: boolean
  remoteUrl?: string
  branch?: string
  lastSyncedCommit?: string
  lastSyncedAt?: string
}

type GitHubSyncResult = {
  status?: string
  commit?: string
}

const DEFAULT_BRANCH = 'main'

const ERROR_MESSAGES: Record<string, string> = {
  github_sync_not_linked: '请先绑定 GitHub 仓库。',
  github_token_required: '推送需要 GitHub token。',
  invalid_branch: '分支名无效。',
  invalid_github_remote_url: '请输入有效的 GitHub 仓库地址。',
  invalid_proxy_url: '服务器 GitHub 代理配置无效，请联系管理员。',
  remote_has_new_commits:
    'GitHub 上有新的提交。请先拉取，或者勾选强制推送后再试。',
}

export default function GitHubSyncPanel() {
  const { projectId } = useProjectContext()
  const [state, setState] = useState<GitHubSyncState>({ linked: false })
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch] = useState(DEFAULT_BRANCH)
  const [token, setToken] = useState('')
  const [force, setForce] = useState(false)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const endpoint = `/project/${projectId}/github-sync`

  const loadState = useCallback(async () => {
    setError(null)
    const nextState = await getJSON<GitHubSyncState>(endpoint)
    setState(nextState)
    setRemoteUrl(nextState.remoteUrl || '')
    setBranch(nextState.branch || DEFAULT_BRANCH)
  }, [endpoint])

  useEffect(() => {
    loadState().catch(error => {
      setError(errorMessage(error))
    })
  }, [loadState])

  const runAction = useCallback(
    async (action: string, task: () => Promise<string>) => {
      setLoadingAction(action)
      setError(null)
      setMessage(null)
      try {
        setMessage(await task())
      } catch (error) {
        setError(errorMessage(error))
      } finally {
        setLoadingAction(null)
      }
    },
    []
  )

  const handleLink = useCallback(() => {
    void runAction('link', async () => {
      const nextState = await postJSON<GitHubSyncState>(`${endpoint}/link`, {
        body: {
          remoteUrl,
          branch: branch || DEFAULT_BRANCH,
        },
      })
      setState(nextState)
      return '仓库已绑定。'
    })
  }, [branch, endpoint, remoteUrl, runAction])

  const handleUnlink = useCallback(() => {
    if (!window.confirm('解除绑定后不会删除 GitHub 仓库或项目文件。继续吗？')) {
      return
    }
    void runAction('unlink', async () => {
      await deleteJSON(`${endpoint}/link`)
      setState({ linked: false })
      return '仓库绑定已解除。'
    })
  }, [endpoint, runAction])

  const handlePull = useCallback(() => {
    void runAction('pull', async () => {
      const result = await postJSON<GitHubSyncResult>(`${endpoint}/pull`, {
        body: {
          token: token || undefined,
        },
      })
      await loadState()
      return `已从 GitHub 拉取 ${shortCommit(result.commit)}。如果文件树未刷新，请刷新页面。`
    })
  }, [endpoint, loadState, runAction, token])

  const handlePush = useCallback(() => {
    void runAction('push', async () => {
      const result = await postJSON<GitHubSyncResult>(`${endpoint}/push`, {
        body: {
          token,
          force,
        },
      })
      await loadState()
      if (result.status === 'unchanged') {
        return '当前项目没有需要推送的改动。'
      }
      return `已推送到 GitHub ${shortCommit(result.commit)}。`
    })
  }, [endpoint, force, loadState, runAction, token])

  const isBusy = loadingAction !== null
  const isLinked = state.linked

  return (
    <section className="integrations-panel-sync" aria-label="GitHub sync">
      <div className="integrations-panel-sync-header">
        <div className="integrations-panel-card-icon">
          <MaterialIcon type="sync" />
        </div>
        <div>
          <h3>GitHub 同步</h3>
          <p>把当前项目和指定 GitHub 仓库的一个分支同步。</p>
        </div>
      </div>

      <label className="integrations-panel-sync-field">
        <span>仓库地址</span>
        <input
          className="form-control"
          value={remoteUrl}
          onChange={event => setRemoteUrl(event.target.value)}
          placeholder="https://github.com/user/repo.git"
          disabled={isBusy}
        />
      </label>

      <label className="integrations-panel-sync-field">
        <span>分支</span>
        <input
          className="form-control"
          value={branch}
          onChange={event => setBranch(event.target.value)}
          placeholder={DEFAULT_BRANCH}
          disabled={isBusy}
        />
      </label>

      <div className="integrations-panel-sync-actions">
        <OLButton
          size="sm"
          variant={isLinked ? 'secondary' : 'primary'}
          onClick={handleLink}
          isLoading={loadingAction === 'link'}
          disabled={isBusy || !remoteUrl}
          leadingIcon="link"
        >
          {isLinked ? '更新绑定' : '绑定仓库'}
        </OLButton>
        {isLinked && (
          <OLButton
            size="sm"
            variant="danger-ghost"
            onClick={handleUnlink}
            isLoading={loadingAction === 'unlink'}
            disabled={isBusy}
            leadingIcon="link_off"
          >
            解除绑定
          </OLButton>
        )}
      </div>

      {isLinked && (
        <>
          <div className="integrations-panel-sync-status">
            <span>当前绑定</span>
            <strong>{state.branch || DEFAULT_BRANCH}</strong>
            {state.lastSyncedCommit && (
              <code>{shortCommit(state.lastSyncedCommit)}</code>
            )}
          </div>

          <label className="integrations-panel-sync-field">
            <span>GitHub token</span>
            <input
              className="form-control"
              type="password"
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder="只用于本次 pull/push，不会保存"
              disabled={isBusy}
            />
          </label>

          <label className="integrations-panel-sync-check">
            <input
              type="checkbox"
              checked={force}
              onChange={event => setForce(event.target.checked)}
              disabled={isBusy}
            />
            <span>强制推送</span>
          </label>

          <div className="integrations-panel-sync-actions">
            <OLButton
              size="sm"
              variant="secondary"
              onClick={handlePull}
              isLoading={loadingAction === 'pull'}
              disabled={isBusy}
              leadingIcon="cloud_download"
            >
              从 GitHub 拉取
            </OLButton>
            <OLButton
              size="sm"
              onClick={handlePush}
              isLoading={loadingAction === 'push'}
              disabled={isBusy || !token}
              leadingIcon="cloud_upload"
            >
              推送到 GitHub
            </OLButton>
          </div>
        </>
      )}

      {message && (
        <div className="integrations-panel-sync-message" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="integrations-panel-sync-error" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}

function shortCommit(commit?: string) {
  if (!commit) {
    return ''
  }
  return commit.slice(0, 7)
}

function errorMessage(error: unknown) {
  const fetchError = error as FetchError
  const errorCode = fetchError.data?.error
  if (typeof errorCode === 'string' && ERROR_MESSAGES[errorCode]) {
    return ERROR_MESSAGES[errorCode]
  }
  if (typeof fetchError.data?.message === 'string') {
    return fetchError.data.message
  }
  if (typeof errorCode === 'string') {
    return errorCode
  }
  return 'GitHub 同步失败，请稍后重试。'
}
