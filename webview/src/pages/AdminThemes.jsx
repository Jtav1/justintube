import ThemeEditor from './ThemeEditor.jsx'

/**
 * Admin-only sitewide theme create/edit form, routed at
 * `/control-panel/themes/new` and `/control-panel/themes/:id/edit`. Thin
 * wrapper around the shared `ThemeEditor` — see there for the actual form.
 */
function AdminThemes() {
  return <ThemeEditor adminMode />
}

export default AdminThemes
