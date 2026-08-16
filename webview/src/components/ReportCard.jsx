import { TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import './ReportCard.css'

const REPORT_TYPE_LABELS = {
  video: 'Video',
  playlist: 'Playlist',
  user: 'User',
  website: 'Site',
  system: 'System',
}

function ReportCard({ report }) {
  const navigate = useNavigate()

  function handleClick() {
    navigate(`/reports/${report.id}`, { state: { report } })
  }

  return (
    <button
      type="button"
      className={`report-card${report.resolved ? ' report-card-resolved' : ' report-card-open'}`}
      onClick={handleClick}
    >
      <span className="report-card-icon">
        <TriangleAlert size={20} />
      </span>
      <div className="report-card-body">
        <div className="report-card-header">
          <span className="report-card-id">#{report.id}</span>
          <span className="report-card-type">{REPORT_TYPE_LABELS[report.reportType] ?? report.reportType}</span>
          <span className={`report-card-status${report.resolved ? ' report-card-status-resolved' : ''}`}>
            {report.resolved ? 'Resolved' : 'Open'}
          </span>
        </div>
        <p className="report-card-description">{report.description}</p>
      </div>
    </button>
  )
}

export default ReportCard
