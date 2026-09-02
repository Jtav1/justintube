import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { UserRound } from 'lucide-react'
import { createComment, deleteComment, listComments, updateComment } from '../api/videos.js'
import { formatRelativeDate } from '../lib/format.js'
import { linkifyCommentText } from '../lib/linkify-comment.js'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import apiClient from '../api/client.js'
import './VideoComments.css'

const INDENT_PX = 28
const MAX_INDENT_DEPTH = 3

/**
 * Builds a flat, depth-annotated, parent-before-children ordering of a flat
 * comment list, newest-first at every level. A deleted comment (`deletedAt`
 * set — the backend soft-deletes and redacts `author`/`body` rather than
 * removing the row, so replies keep a valid parent) is omitted entirely when
 * it has no replies, or when every one of its replies is itself omitted this
 * same way (recursively — a whole dead-end chain of nothing-but-deleted
 * comments collapses away together). It's kept in the order (as a
 * "[Deleted]" placeholder — see the render below) as soon as any descendant,
 * at any depth, is still live, so that descendant keeps a parent to nest
 * under.
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

  // Memoized bottom-up: a live comment is never hidden; a deleted comment is
  // hidden iff it has no replies, or every reply is (recursively) hidden too.
  const hiddenById = new Map()
  function isHidden(comment) {
    if (!comment.deletedAt) {
      return false
    }
    if (hiddenById.has(comment.id)) {
      return hiddenById.get(comment.id)
    }
    const children = childrenByParent.get(comment.id) ?? []
    const hidden = children.length === 0 || children.every(isHidden)
    hiddenById.set(comment.id, hidden)
    return hidden
  }

  const ordered = []
  function visit(nodes, depth) {
    for (const node of nodes) {
      if (!isHidden(node)) {
        ordered.push({ ...node, depth })
      }
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
  const { error: toastError } = useToast()
  const [body, setBody] = useState('')
  const [modChecked, setModChecked] = useState(false)
  const [adminChecked, setAdminChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)

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
      toastError('Failed to post comment.')
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
    </form>
  )
}

/**
 * Inline body editor for a single existing comment, shown in place of its
 * rendered text while editing. Only the body can be changed here —
 * `distinguishedMod`/`distinguishedAdmin` are toggled elsewhere and aren't
 * editable by a comment's own author.
 *
 * @param {{
 *   initialBody: string,
 *   onSave: (body: string) => Promise<void>,
 *   onCancel: () => void,
 * }} props
 */
function CommentEditForm({ initialBody, onSave, onCancel }) {
  const { error: toastError } = useToast()
  const [body, setBody] = useState(initialBody)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    const trimmed = body.trim()
    if (!trimmed || submitting) {
      return
    }
    setSubmitting(true)
    try {
      await onSave(trimmed)
    } catch {
      toastError('Failed to update comment.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="video-comments-composer" onSubmit={handleSubmit}>
      <textarea
        rows={2}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        autoFocus
      />
      <div className="video-comments-composer-row">
        <div />
        <div className="video-comments-composer-actions">
          <button type="button" className="video-comments-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={!body.trim() || submitting}>
            Save
          </button>
        </div>
      </div>
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
  const { error: toastError } = useToast()
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [replyingToId, setReplyingToId] = useState(null)
  const [editingId, setEditingId] = useState(null)

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
      } catch {
        if (!cancelled) {
          toastError('Failed to load comments.')
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
  }, [video.id, toastError])

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

  async function handleUpdate(comment, body) {
    const updated = await updateComment(video.id, comment.id, { body })
    setComments((prev) => prev.map((c) => (c.id === comment.id ? updated : c)))
    setEditingId(null)
  }

  async function handleDelete(comment) {
    if (!window.confirm('Delete this comment? This cannot be undone.')) {
      return
    }
    try {
      await deleteComment(video.id, comment.id)
      // The API soft-deletes (204, no body): mirror what a refetch would
      // return so replies keep their parent and buildDisplayOrder can decide
      // whether to show a "[Deleted]" placeholder or hide it entirely.
      setComments((prev) =>
        prev.map((c) =>
          c.id === comment.id
            ? {
                ...c,
                deletedAt: new Date().toISOString(),
                author: null,
                body: null,
                distinguishedMod: false,
                distinguishedAdmin: false,
              }
            : c,
        ),
      )
    } catch {
      toastError('Failed to delete comment.')
    }
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
          const authorName = comment.deletedAt
            ? '[Deleted]'
            : comment.author?.displayName || comment.author?.username
          const isOwnComment = user && Number(user.id) === Number(comment.author?.userId)
          // Mirrors the backend's deleteComment authorization: the author
          // may always delete their own comment; a moderator may delete any
          // comment that isn't distinguishedAdmin; an admin may delete any
          // comment. Never true for an already-deleted comment - it has
          // nothing left to delete, and no edit/delete affordance should
          // show on a "[Deleted]" placeholder.
          const canDeleteComment =
            !comment.deletedAt &&
            (isOwnComment || isAdmin || (isModerator && !comment.distinguishedAdmin))
          const isEditing = editingId === comment.id

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
                {isEditing ? (
                  <CommentEditForm
                    initialBody={comment.body}
                    onSave={(body) => handleUpdate(comment, body)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : comment.deletedAt ? (
                  <p className="video-comments-item-text video-comments-item-text-deleted">
                    [Deleted]
                  </p>
                ) : (
                  <p className="video-comments-item-text">
                    {linkifyCommentText(comment.body)}
                    {comment.updatedAt !== comment.createdAt && (
                      <span className="video-comments-edited-tag"> (edited)</span>
                    )}
                  </p>
                )}
                {!isEditing && (
                  <div className="video-comments-item-actions">
                    {user && composerAvailable && (
                      <button
                        type="button"
                        className="video-comments-reply-toggle"
                        onClick={() => setReplyingToId((prev) => (prev === comment.id ? null : comment.id))}
                      >
                        Reply
                      </button>
                    )}
                    {isOwnComment && !comment.deletedAt && (
                      <button
                        type="button"
                        className="video-comments-reply-toggle"
                        onClick={() => {
                          setEditingId(comment.id)
                          setReplyingToId(null)
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {canDeleteComment && (
                      <button
                        type="button"
                        className="video-comments-reply-toggle video-comments-delete-toggle"
                        onClick={() => handleDelete(comment)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
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
