import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteJSON, getJSON, postJSON } from '@/infrastructure/fetch-json'
import type { FetchError } from '@/infrastructure/fetch-json'
import { useProjectContext } from '@/shared/context/project-context'
import { useEditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import useAbortController from '@/shared/hooks/use-abort-controller'
import { signalWithTimeout } from '@/utils/abort-signal'

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
  changes?: GitHubSyncChange[]
  changesTruncated?: boolean
  reloadRequired?: boolean
}

type GitHubSyncChange = {
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed'
  path: string
  oldPath?: string
}

type ActionFeedback = {
  message: string
  changes?: GitHubSyncChange[]
  changesTruncated?: boolean
  reloadAfterMs?: number
}

const DEFAULT_BRANCH = 'main'
const SAVE_BEFORE_PUSH_TIMEOUT_MS = 15000

const ERROR_MESSAGES: Record<string, string> = {
  github_sync_not_linked: '请先绑定 GitHub 仓库。',
  github_token_required: '推送需要 GitHub token。',
  invalid_branch: '分支名无效。',
  invalid_github_remote_url: '请输入有效的 GitHub 仓库地址。',
  invalid_proxy_url: '服务器 GitHub 代理配置无效，请联系管理员。',
  local_changes_not_saved: '本地修改仍在保存中，请稍后再推送。',
  remote_has_new_commits:
    'GitHub 上有新的提交。请先拉取，或者勾选强制推送后再试。',
}

export default function GitHubSyncPanel() {
  const { projectId } = useProjectContext()
  const { openDocs } = useEditorManagerContext()
  const { signal } = useAbortController()
  const [state, setState] = useState<GitHubSyncState>({ linked: false })
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch] = useState(DEFAULT_BRANCH)
  const [token, setToken] = useState('')
  const [force, setForce] = useState(false)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changes, setChanges] = useState<GitHubSyncChange[]>([])
  const [changesTruncated, setChangesTruncated] = useState(false)
  const reloadTimerRef = useRef<number | null>(null)

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

  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) {
        window.clearTimeout(reloadTimerRef.current)
      }
    }
  }, [])

  const runAction = useCallback(
    async (action: string, task: () => Promise<string | ActionFeedback>) => {
      setLoadingAction(action)
      setError(null)
      setMessage(null)
      setChanges([])
      setChangesTruncated(false)
      if (reloadTimerRef.current) {
        window.clearTimeout(reloadTimerRef.current)
        reloadTimerRef.current = null
      }
      try {
        const feedback = await task()
        if (typeof feedback === 'string') {
          setMessage(feedback)
        } else {
          setMessage(feedback.message)
          setChanges(feedback.changes || [])
          setChangesTruncated(feedback.changesTruncated === true)
          if (feedback.reloadAfterMs) {
            reloadTimerRef.current = window.setTimeout(() => {
              window.location.reload()
            }, feedback.reloadAfterMs)
          }
        }
      } catch (error) {
        setError(errorMessage(error))
      } finally {
        setLoadingAction(null)
      }
    },
    [],
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
      return {
        message: `已从 GitHub 拉取 ${shortCommit(
          result.commit,
        )}。页面将在 5 秒后自动刷新。`,
        changes: result.changes,
        changesTruncated: result.changesTruncated,
        reloadAfterMs: result.reloadRequired === false ? undefined : 5000,
      }
    })
  }, [endpoint, loadState, runAction, token])

  const handlePush = useCallback(() => {
    void runAction('push', async () => {
      setMessage('正在保存本地修改...')
      await openDocs.awaitBufferedOps(
        signalWithTimeout(signal, SAVE_BEFORE_PUSH_TIMEOUT_MS),
      )
      if (openDocs.hasUnsavedChanges()) {
        throw new Error('local_changes_not_saved')
      }
      const result = await postJSON<GitHubSyncResult>(`${endpoint}/push`, {
        body: {
          token,
          force,
        },
      })
      await loadState()
      if (result.status === 'unchanged') {
        return {
          message: '当前项目没有需要推送的改动。',
          changes: [],
          changesTruncated: false,
        }
      }
      return {
        message: `已推送到 GitHub ${shortCommit(result.commit)}。`,
        changes: result.changes,
        changesTruncated: result.changesTruncated,
      }
    })
  }, [endpoint, force, loadState, openDocs, runAction, signal, token])

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
      {changes.length > 0 && (
        <div className="integrations-panel-sync-changes">
          <span>本轮文件变更</span>
          <ul>
            {changes.map(change => (
              <li
                key={`${change.status}:${change.oldPath || ''}:${change.path}`}
              >
                <strong>{changeStatusLabel(change.status)}</strong>
                {change.oldPath ? (
                  <>
                    <code>{change.oldPath}</code>
                    <span aria-hidden="true">-&gt;</span>
                  </>
                ) : null}
                <code>{change.path}</code>
              </li>
            ))}
          </ul>
          {changesTruncated && <p>仅显示前 100 个变更文件。</p>}
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

function changeStatusLabel(status: GitHubSyncChange['status']) {
  switch (status) {
    case 'added':
      return '新增'
    case 'modified':
      return '修改'
    case 'deleted':
      return '删除'
    case 'renamed':
      return '重命名'
    case 'copied':
      return '复制'
    default:
      return '变更'
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && ERROR_MESSAGES[error.message]) {
    return ERROR_MESSAGES[error.message]
  }
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
