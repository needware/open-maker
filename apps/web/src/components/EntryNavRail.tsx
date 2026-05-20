// Lovart-style left navigation rail for the entry view.
//
// Renders a narrow icon-only column. The first slot is the brand
// logo, which doubles as the Home destination: clicking it always
// navigates to home, and it carries the active `aria-current="page"`
// treatment when the home view is showing, so we do not need a
// separate Home button in the primary nav group. Primary actions
// (new project, projects, automations, design systems) follow.
// Secondary platform items (plugins, integrations) live in the footer
// section alongside the help launcher — they are accessible but visually
// de-emphasised relative to the daily-use primary destinations.
// Language switching and other account-scoped controls live behind the
// floating settings cog in the top-right corner of the main content.

import type { ReactNode } from 'react';
import { EntryHelpMenu } from './EntryHelpMenu';
import { Icon } from './Icon';
import { useT } from '../i18n';

export type EntryView =
  | 'home'
  | 'projects'
  | 'tasks'
  | 'plugins'
  | 'design-systems'
  | 'integrations';

interface Props {
  view: EntryView;
  onViewChange: (view: EntryView) => void;
  onNewProject: () => void;
  // Fork-only entry point for the workspace folder picker. Always visible
  // alongside "New project" so the user can land in an existing folder
  // from any entry view (not just the chat-first HomeHero migrate rail).
  // EntryShell wires this to handleChipFolderImport, which prefers the
  // secure Electron pickAndImport bridge and falls back to opening the
  // New Project modal in browser-only shells.
  onOpenFolder?: () => void;
  openingFolder?: boolean;
}

interface NavButtonProps {
  active?: boolean;
  ariaLabel: string;
  tooltip: string;
  onClick: () => void;
  testId?: string;
  disabled?: boolean;
  children: ReactNode;
}

function NavButton({ active, ariaLabel, tooltip, onClick, testId, disabled, children }: NavButtonProps) {
  return (
    <button
      type="button"
      className={`entry-nav-rail__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      data-tooltip={tooltip}
      disabled={disabled}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {children}
    </button>
  );
}

export function EntryNavRail({ view, onViewChange, onNewProject, onOpenFolder, openingFolder }: Props) {
  const t = useT();
  const brandLabel = t('app.brand');
  const homeLabel = t('entry.navHome');
  const isHome = view === 'home';
  const logoTooltip = isHome ? brandLabel : `${brandLabel} · ${homeLabel}`;

  return (
    <nav className="entry-nav-rail" aria-label="Primary">
      <div className="entry-nav-rail__group">
        <button
          type="button"
          className={`entry-nav-rail__logo${isHome ? ' is-active' : ''}`}
          onClick={() => onViewChange('home')}
          aria-label={brandLabel}
          aria-current={isHome ? 'page' : undefined}
          data-tooltip={logoTooltip}
          data-testid="entry-nav-logo"
        >
          <img
            src="/app-icon.svg"
            alt=""
            className="entry-nav-rail__logo-img"
            draggable={false}
          />
        </button>
        <NavButton
          ariaLabel={t('entry.navNewProject')}
          tooltip={t('entry.navNewProject')}
          onClick={onNewProject}
          testId="entry-nav-new-project"
        >
          <Icon name="plus" size={18} />
        </NavButton>
        {onOpenFolder ? (
          <NavButton
            ariaLabel={t('entry.navOpenFolder')}
            tooltip={t('entry.navOpenFolder')}
            onClick={onOpenFolder}
            testId="entry-nav-open-folder"
            disabled={openingFolder}
          >
            <Icon name="import" size={18} />
          </NavButton>
        ) : null}
        <NavButton
          active={view === 'projects'}
          ariaLabel={t('entry.navProjects')}
          tooltip={t('entry.navProjects')}
          onClick={() => onViewChange('projects')}
          testId="entry-nav-projects"
        >
          <Icon name="folder" size={18} />
        </NavButton>
        <NavButton
          active={view === 'tasks'}
          ariaLabel={t('entry.navTasks')}
          tooltip={t('entry.navTasks')}
          onClick={() => onViewChange('tasks')}
          testId="entry-nav-tasks"
        >
          <Icon name="kanban" size={18} />
        </NavButton>
        <NavButton
          active={view === 'design-systems'}
          ariaLabel={t('entry.navDesignSystems')}
          tooltip={t('entry.navDesignSystems')}
          onClick={() => onViewChange('design-systems')}
          testId="entry-nav-design-systems"
        >
          <Icon name="palette" size={18} />
        </NavButton>
      </div>
      <div className="entry-nav-rail__footer">
        <div className="entry-nav-rail__divider" role="separator" />
        <NavButton
          active={view === 'plugins'}
          ariaLabel="Plugins"
          tooltip="Plugins"
          onClick={() => onViewChange('plugins')}
          testId="entry-nav-plugins"
        >
          <Icon name="grid" size={18} />
        </NavButton>
        <NavButton
          active={view === 'integrations'}
          ariaLabel={t('entry.navIntegrations')}
          tooltip={t('entry.navIntegrations')}
          onClick={() => onViewChange('integrations')}
          testId="entry-nav-integrations"
        >
          <Icon name="link" size={18} />
        </NavButton>
        <EntryHelpMenu />
      </div>
    </nav>
  );
}
