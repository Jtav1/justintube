import ThemeEditor from './ThemeEditor.jsx'

/**
 * Personal (non-admin) theme create/edit form, routed at
 * `/settings/themes/new` and `/settings/themes/:id/edit`, usable by any
 * signed-in user for their own private themes. Thin wrapper around the
 * shared `ThemeEditor` — see there for the actual form.
 */
function MyThemeEditor() {
  return <ThemeEditor adminMode={false} />
}

export default MyThemeEditor
