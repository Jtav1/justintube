import './ReactionScore.css'

/**
 * Displays a video's aggregate like/dislike totals as "+likeCount | -dislikeCount",
 * the like count in green and the dislike count in red.
 * @param {{likeCount?: number, dislikeCount?: number}} props
 */
function ReactionScore({ likeCount = 0, dislikeCount = 0 }) {
  return (
    <p className="reaction-score">
      <span className="reaction-score-like">+{likeCount}</span>
      <span className="reaction-score-separator">|</span>
      <span className="reaction-score-dislike">-{dislikeCount}</span>
    </p>
  )
}

export default ReactionScore
