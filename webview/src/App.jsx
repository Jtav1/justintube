import { Route, Routes } from 'react-router-dom'
import AppLayout from './layouts/AppLayout.jsx'
import VideoListing from './pages/VideoListing.jsx'
import LoginPage from './pages/LoginPage.jsx'
import RegisterPage from './pages/RegisterPage.jsx'
import VerifyEmailPage from './pages/VerifyEmailPage.jsx'
import ProfilePage from './pages/ProfilePage.jsx'
import UploadPage from './pages/UploadPage.jsx'
import CreatePlaylistPage from './pages/CreatePlaylistPage.jsx'
import VideoPage from './pages/VideoPage.jsx'
import ControlPanelPage from './pages/AdminPanel.jsx'
import ModReportsPage from './pages/ModReports.jsx'
import UserPlaylistsPage from './pages/UserPlaylists.jsx'
import PlaylistsPage from './pages/Playlists.jsx'
import FeaturedVideosPage from './pages/FeaturedVideos.jsx'
import SubscriptionsPage from './pages/UserSubscriptions.jsx'
import LikedVideosPage from './pages/LikedVideos.jsx'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/control-panel" element={<ControlPanelPage />} />
      <Route path="/reports" element={<ModReportsPage />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<VideoListing />} />
        <Route path="/video" element={<VideoPage />} />
        <Route path="/users/:username" element={<ProfilePage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/playlists/new" element={<CreatePlaylistPage />} />
        <Route path="/playlists/:id/edit" element={<CreatePlaylistPage />} />
        <Route path="/users/:username/playlists" element={<UserPlaylistsPage />} />
        <Route path="/playlists" element={<PlaylistsPage />} />
        <Route path="/liked/:username" element={<LikedVideosPage />} />
        <Route path="/featured" element={<FeaturedVideosPage />} />
        <Route path="/subscriptions" element={<SubscriptionsPage />} />
      </Route>
    </Routes>
  )
}

export default App
