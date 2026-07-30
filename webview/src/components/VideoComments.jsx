import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { UserRound } from 'lucide-react'
import { createComment, listComments } from '../api/videos.js'
import { formatRelativeDate } from '../lib/format.js'
import { useAuth } from '../context/useAuth.js'
import apiClient from '../api/client.js'
import './VideoComments.css'

const INDENT_PX = 28
const MAX_INDENT_DEPTH = 3

/**
 * Builds a flat, depth-annotated, parent-before-children ordering of a flat
 * comment list, newest-first at every level.
 *
 * @param {object[]} comments Flat comments from `listComments`.
 * @returns {Array<object & {depth: number}>} Depth-first ordered comments.
 */
function buildDisplayOrder(comments) {
  const childrenByParent = new Map()
  const roots = []

  for (const comment of comments) {
    if (comment.parentCommentId == null) {
      roots.push(comment)
      continue
    }
    const siblings = childrenByParent.get(comment.parentCommentId) ?? []
    siblings.push(comment)
    childrenByParent.set(comment.parentCommentId, siblings)
  }

  // Tie-break on id (higher = newer) since createdAt precision can tie when
  // comments are posted within the same second.
  const byNewest = (a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.id - a.id
  roots.sort(byNewest)
  for (const siblings of childrenByParent.values()) {
    siblings.sort(byNewest)
  }

  const ordered = []
  function visit(nodes, depth) {
    for (const node of nodes) {
      ordered.push({ ...node, depth })
      visit(childrenByParent.get(node.id) ?? [], depth + 1)
    }
  }
  visit(roots, 1)
  return ordered
}

/**
 * Avatar image with a UserRound fallback on missing/broken avatar.
 * @param {{username: string|undefined}} props
 */
function CommentAvatar({ username }) {
  const [failed, setFailed] = useState(false)
  const avatarUrl = username ? `${apiClient.defaults.baseURL}/api/v1/users/${username}/avatar` : null

  if (!avatarUrl || failed) {
    return (
      <span className="video-comments-avatar video-comments-avatar-placeholder">
        <UserRound size={18} />
      </span>
    )
  }
  return (
    <img
      className="video-comments-avatar"
      src={avatarUrl}
      alt=""
      onError={() => setFailed(true)}
    />
  )
}

/**
 * A textbox + role-gated distinguished checkboxes, used both for the
 * top-level composer and for a per-comment reply composer.
 *
 * @param {{
 *   isModerator: boolean,
 *   isAdmin: boolean,
 *   commentsEnabled: boolean,
 *   submitLabel: string,
 *   onSubmit: (payload: {body: string, distinguishedMod?: boolean, distinguishedAdmin?: boolean}) => Promise<void>,
 *   onCancel?: () => void,
 *   autoFocus?: boolean,
 * }} props
 */
function CommentComposer({ isModerator, isAdmin, commentsEnabled, submitLabel, onSubmit, onCancel, autoFocus }) {
  const [body, setBody] = useState('')
  const [modChecked, setModChecked] = useState(false)
  const [adminChecked, setAdminChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const canShowModCheckbox = isModerator || isAdmin
  const canShowAdminCheckbox = isAdmin
  const canBypassDisabled = modChecked || adminChecked
  const blockedByDisabled = !commentsEnabled && !canBypassDisabled

  async function handleSubmit(event) {
    event.preventDefault()
    if (!body.trim() || blockedByDisabled || submitting) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        body: body.trim(),
        ...(canShowModCheckbox ? { distinguishedMod: modChecked } : {}),
        ...(canShowAdminCheckbox ? { distinguishedAdmin: adminChecked } : {}),
      })
      setBody('')
      setModChecked(false)
      setAdminChecked(false)
    } catch {
      setError('Failed to post comment.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="video-comments-composer" onSubmit={handleSubmit}>
      <textarea
        rows={2}
        placeholder="Add a comment..."
        value={body}
        onChange={(event) => setBody(event.target.value)}
        autoFocus={autoFocus}
      />
      <div className="video-comments-composer-row">
        <div className="video-comments-composer-flags">
          {canShowModCheckbox && (
            <label className="video-comments-checkbox">
              <input
                type="checkbox"
                checked={modChecked}
                onChange={(event) => setModChecked(event.target.checked)}
              />
              Mod comment
            </label>
          )}
          {canShowAdminCheckbox && (
            <label className="video-comments-checkbox">
              <input
                type="checkbox"
                checked={adminChecked}
                onChange={(event) => setAdminChecked(event.target.checked)}
              />
              Admin comment
            </label>
          )}
        </div>
        <div className="video-comments-composer-actions">
          {onCancel && (
            <button type="button" className="video-comments-cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" disabled={!body.trim() || blockedByDisabled || submitting}>
            {submitLabel}
          </button>
        </div>
      </div>
      {blockedByDisabled && (
        <p className="video-comments-disabled-note">
          Comments are disabled on this video{canShowModCheckbox ? ' — check a box above to post anyway.' : '.'}
        </p>
      )}
      {error && <p className="video-comments-error">{error}</p>}
    </form>
  )
}

/**
 * Video comments section: a composer plus a recursively-nested comment list.
 * Nesting indent stops increasing past depth 3; from depth 4 on, comments are
 * capped to 50% of this component's width.
 *
 * @param {{video: object}} props The currently-playing video (from getVideo).
 */
function VideoComments({ video }) {
  const { user } = useAuth()
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [replyingToId, setReplyingToId] = useState(null)

  const isModerator = user?.role === 'moderator'
  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const data = await listComments(video.id)
        if (!cancelled) {
          setComments(data.items ?? [])
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [video.id])

  const displayOrder = useMemo(() => buildDisplayOrder(comments), [comments])
  const canPostWhileDisabled = isModerator || isAdmin
  const composerAvailable = Boolean(video.commentsEnabled) || canPostWhileDisabled

  async function handlePost(parentCommentId, payload) {
    // parentCommentId must be omitted (not null) for top-level comments: the
    // backend only treats the key as "provided" when it isn't undefined, and
    // JSON.stringify only drops undefined (not null) values.
    const created = await createComment(video.id, {
      ...payload,
      ...(parentCommentId != null ? { parentCommentId } : {}),
    })
    setComments((prev) => [...prev, created])
    setReplyingToId(null)
  }

  return (
    <section className="video-comments">
      <h2 className="video-comments-title">Comments</h2>

      {user && composerAvailable && (
        <CommentComposer
          isModerator={isModerator}
          isAdmin={isAdmin}
          commentsEnabled={Boolean(video.commentsEnabled)}
          submitLabel="Post"
          onSubmit={(payload) => handlePost(null, payload)}
        />
      )}
      {user && !composerAvailable && (
        <p className="video-comments-disabled-note">Comments are disabled on this video.</p>
      )}

      {loading && <p className="video-comments-empty">Loading comments…</p>}
      {!loading && displayOrder.length === 0 && (
        <p className="video-comments-empty">No comments yet.</p>
      )}

      <div className="video-comments-list">
        {displayOrder.map((comment) => {
          const indentDepth = Math.min(comment.depth, MAX_INDENT_DEPTH)
          const marginLeft = (indentDepth - 1) * INDENT_PX
          const style = {
            marginLeft,
            width: comment.depth >= MAX_INDENT_DEPTH + 1 ? '50%' : `calc(100% - ${marginLeft}px)`,
          }
          const authorName = comment.author?.displayName || comment.author?.username

          const itemClassName = comment.distinguishedAdmin
            ? 'video-comments-item video-comments-item-admin'
            : comment.distinguishedMod
              ? 'video-comments-item video-comments-item-mod'
              : 'video-comments-item'

          return (
            <div key={comment.id} className={itemClassName} style={style}>
              <Link
                to={comment.author?.username ? `/users/${comment.author.username}` : '#'}
                className="video-comments-avatar-link"
              >
                <CommentAvatar username={comment.author?.username} />
              </Link>
              <div className="video-comments-item-body">
                <p className="video-comments-item-meta">
                  <Link to={comment.author?.username ? `/users/${comment.author.username}` : '#'}>
                    {authorName}
                  </Link>
                  {comment.distinguishedAdmin && (
                    <span className="video-comments-badge video-comments-badge-admin">ADMIN</span>
                  )}
                  {comment.distinguishedMod && (
                    <span className="video-comments-badge video-comments-badge-mod">MOD</span>
                  )}
                  <span className="video-comments-timestamp">
                    {formatRelativeDate(comment.createdAt)}
                  </span>
                </p>
                <p className="video-comments-item-text">{comment.body}</p>
                {user && composerAvailable && (
                  <button
                    type="button"
                    className="video-comments-reply-toggle"
                    onClick={() => setReplyingToId((prev) => (prev === comment.id ? null : comment.id))}
                  >
                    Reply
                  </button>
                )}
                {replyingToId === comment.id && (
                  <CommentComposer
                    isModerator={isModerator}
                    isAdmin={isAdmin}
                    commentsEnabled={Boolean(video.commentsEnabled)}
                    submitLabel="Reply"
                    onSubmit={(payload) => handlePost(comment.id, payload)}
                    onCancel={() => setReplyingToId(null)}
                    autoFocus
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default VideoComments
