import { lazy, Suspense } from 'react'
import { Route, Routes, useParams } from 'react-router-dom'
import AppLayout from './layouts/AppLayout.jsx'
import VideoListing from './pages/VideoListing.jsx'
import LoginPage from './pages/LoginPage.jsx'
import RegisterPage from './pages/RegisterPage.jsx'
import VideoPage from './pages/VideoPage.jsx'
import SearchResultsPage from './pages/SearchResults.jsx'
import { useSiteConfig } from './context/useSiteConfig.js'
import RouteLoadingFallback from './components/RouteLoadingFallback.jsx'

const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage.jsx'))
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage.jsx'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage.jsx'))
const ProfilePage = lazy(() => import('./pages/ProfilePage.jsx'))
const UploadPage = lazy(() => import('./pages/UploadPage.jsx'))
const GoLivePage = lazy(() => import('./pages/GoLivePage.jsx'))
const LiveWatchPage = lazy(() => import('./pages/LiveWatchPage.jsx'))
const CreatePlaylistPage = lazy(() => import('./pages/CreatePlaylistPage.jsx'))
const PlaylistPage = lazy(() => import('./pages/PlaylistPage.jsx'))
const ControlPanelPage = lazy(() => import('./pages/AdminPanel.jsx'))
const AdminThemesPage = lazy(() => import('./pages/AdminThemes.jsx'))
const AdminTranscodeProfilesPage = lazy(() => import('./pages/AdminTranscodeProfiles.jsx'))
const ReportsPage = lazy(() => import('./pages/ReportsPage.jsx'))
const ReportForm = lazy(() => import('./pages/ReportForm.jsx'))
const UserPlaylistsPage = lazy(() => import('./pages/UserPlaylists.jsx'))
const PlaylistsPage = lazy(() => import('./pages/Playlists.jsx'))
const FeaturedVideosPage = lazy(() => import('./pages/FeaturedVideos.jsx'))
const UsersListPage = lazy(() => import('./pages/UsersList.jsx'))
const AccountSettingsPage = lazy(() => import('./pages/AccountSettings.jsx'))
const ApiKeysPage = lazy(() => import('./pages/ApiKeysPage.jsx'))
const MyThemesPage = lazy(() => import('./pages/MyThemes.jsx'))
const MyThemeEditorPage = lazy(() => import('./pages/MyThemeEditor.jsx'))
const SubscriptionsPage = lazy(() => import('./pages/UserSubscriptions.jsx'))
const MySubscriptionsPage = lazy(() => import('./pages/MySubscriptions.jsx'))
const SubscribersPage = lazy(() => import('./pages/Subscribers.jsx'))
const LikedVideosPage = lazy(() => import('./pages/LikedVideos.jsx'))
const HistoryPage = lazy(() => import('./pages/History.jsx'))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage.jsx'))

// /reports/new and /reports/:id render the same ReportForm component at the
// same position in the route tree, so React Router won't remount it when
// navigating between them (e.g. right after creating a report, or from one
// report's page directly to another's) - it just re-renders with new
// params, leaving ReportForm's useState-seeded fields stuck on stale
// values. Keying on the report identity forces a clean remount whenever the
// report identity changes.
function ReportFormRoute() {
  const { id } = useParams()
  return <ReportForm key={id ?? 'new'} />
}

function App() {
  const { livestreamEnabled } = useSiteConfig()

  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<VideoListing />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/reports/new" element={<ReportFormRoute />} />
          <Route path="/reports/:id" element={<ReportFormRoute />} />
          <Route path="/control-panel" element={<ControlPanelPage />} />
          <Route path="/control-panel/themes/new" element={<AdminThemesPage />} />
          <Route path="/control-panel/themes/:id/edit" element={<AdminThemesPage />} />
          <Route path="/control-panel/transcode-profiles/new" element={<AdminTranscodeProfilesPage />} />
          <Route path="/control-panel/transcode-profiles/:id/edit" element={<AdminTranscodeProfilesPage />} />
          <Route path="/video" element={<VideoPage />} />
          <Route path="/users/:username" element={<ProfilePage />} />
          <Route path="/upload" element={<UploadPage />} />
          {livestreamEnabled && <Route path="/go-live" element={<GoLivePage />} />}
          {livestreamEnabled && <Route path="/live/:id" element={<LiveWatchPage />} />}
          <Route path="/playlists/new" element={<CreatePlaylistPage />} />
          <Route path="/playlists/:id/edit" element={<CreatePlaylistPage />} />
          <Route path="/playlists/:id" element={<PlaylistPage />} />
          <Route path="/users/:username/playlists" element={<UserPlaylistsPage />} />
          <Route path="/playlists" element={<PlaylistsPage />} />
          <Route path="/liked/:username" element={<LikedVideosPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/featured" element={<FeaturedVideosPage />} />
          <Route path="/users" element={<UsersListPage />} />
          <Route path="/search" element={<SearchResultsPage />} />
          <Route path="/settings" element={<AccountSettingsPage />} />
          <Route path="/settings/api-keys" element={<ApiKeysPage />} />
          <Route path="/settings/themes" element={<MyThemesPage />} />
          <Route path="/settings/themes/new" element={<MyThemeEditorPage />} />
          <Route path="/settings/themes/:id/edit" element={<MyThemeEditorPage />} />
          <Route path="/subscriptions" element={<SubscriptionsPage />} />
          <Route path="/subscriptions/mine" element={<MySubscriptionsPage />} />
          <Route path="/subscribers" element={<SubscribersPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default App
