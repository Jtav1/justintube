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
import AdminThemesPage from './pages/AdminThemes.jsx'
import ModReportsPage from './pages/ModReports.jsx'
import UserPlaylistsPage from './pages/UserPlaylists.jsx'
import PlaylistsPage from './pages/Playlists.jsx'
import FeaturedVideosPage from './pages/FeaturedVideos.jsx'
import UsersListPage from './pages/UsersList.jsx'
import SearchResultsPage from './pages/SearchResults.jsx'
import AccountSettingsPage from './pages/AccountSettings.jsx'
import SubscriptionsPage from './pages/UserSubscriptions.jsx'
import MySubscriptionsPage from './pages/MySubscriptions.jsx'
import SubscribersPage from './pages/Subscribers.jsx'
import LikedVideosPage from './pages/LikedVideos.jsx'
import HistoryPage from './pages/History.jsx'
import NotificationsPage from './pages/NotificationsPage.jsx'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/reports" element={<ModReportsPage />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<VideoListing />} />
        <Route path="/control-panel" element={<ControlPanelPage />} />
        <Route path="/control-panel/themes/new" element={<AdminThemesPage />} />
        <Route path="/control-panel/themes/:id/edit" element={<AdminThemesPage />} />
        <Route path="/video" element={<VideoPage />} />
        <Route path="/users/:username" element={<ProfilePage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/playlists/new" element={<CreatePlaylistPage />} />
        <Route path="/playlists/:id/edit" element={<CreatePlaylistPage />} />
        <Route path="/users/:username/playlists" element={<UserPlaylistsPage />} />
        <Route path="/playlists" element={<PlaylistsPage />} />
        <Route path="/liked/:username" element={<LikedVideosPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/featured" element={<FeaturedVideosPage />} />
        <Route path="/users" element={<UsersListPage />} />
        <Route path="/search" element={<SearchResultsPage />} />
        <Route path="/settings" element={<AccountSettingsPage />} />
        <Route path="/subscriptions" element={<SubscriptionsPage />} />
        <Route path="/subscriptions/mine" element={<MySubscriptionsPage />} />
        <Route path="/subscribers" element={<SubscribersPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
      </Route>
    </Routes>
  )
}

export default App
