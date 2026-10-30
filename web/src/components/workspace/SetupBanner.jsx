import { useNavigate } from 'react-router-dom';
import { Rocket, PlugZap } from 'lucide-react';
import { api } from '../../api.js';
import Button from '../Button.jsx';

// What is still missing from a project, in the order the setup popup asks for it, or null when it is
// all done. A project that was created but never connected shows zeros on every page; this says why.
export function setupGap(site) {
  if (!site || (site.status && site.status !== 'active')) return null;
  if (site.property_type === 'product') return null; // a product has no Search Console or Analytics to connect
  if (!site.gsc_property || !site.ga4_property_id) {
    return 'Google is not connected yet, so these pages have no data to show. Connect Search Console and Analytics to fill them in.';
  }
  if (!site.repo_owner || !site.repo_name) {
    return 'Your GitHub repository is not connected yet. Once it is, the agent can prepare fixes as pull requests.';
  }
  if (!site.onboarded_at) return 'Your baseline has not been built yet. It tells you where you stand today.';
  return null;
}

// A strip above every project page while that project's setup is unfinished. The button reopens the
// same Add project popup on the step that is left (the Workspace page handles ?finish=<id>).
export default function SetupBanner({ site }) {
  const navigate = useNavigate();
  // The project's own Google sign-in stopped working (revoked, expired, or unreadable here).
  // Per project: another client's connection never changes what this one shows.
  if (site?.google_connection && site.google_connection.status !== 'ok' && (!site.status || site.status === 'active')) {
    const reconnect = async () => {
      try {
        const { url } = await api.project.connect.googleStart(site.id);
        window.location.href = url;
      } catch {
        navigate(`/workspace?finish=${site.id}`);
      }
    };
    return (
      <div className="mx-4 md:mx-6 mt-4 rounded-card bg-primary-tint px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
        style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }} role="alert">
        <span className="w-6 h-6 rounded-control bg-white text-primary grid place-items-center shrink-0"><PlugZap size={13} /></span>
        <div className="min-w-0 flex-1 basis-[240px]">
          <p className="text-[13px] font-medium text-fg">Google connection expired</p>
          <p className="text-xs text-text">{site.name} stopped updating because Google no longer lets us read it. Reconnect to pick up where it left off.</p>
        </div>
        <Button variant="primary" size="sm" onClick={reconnect}>Reconnect Google</Button>
      </div>
    );
  }
  const gap = setupGap(site);
  if (!gap) return null;
  return (
    <div className="mx-4 md:mx-6 mt-4 rounded-card bg-primary-tint px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
      style={{ boxShadow: 'inset 0 0 0 1px var(--primary-ring)' }} role="status">
      <span className="w-6 h-6 rounded-control bg-white text-primary grid place-items-center shrink-0"><Rocket size={13} /></span>
      <div className="min-w-0 flex-1 basis-[240px]">
        <p className="text-[13px] font-medium text-fg">Finish setting up {site.name}</p>
        <p className="text-xs text-text">{gap}</p>
      </div>
      <Button variant="primary" size="sm" onClick={() => navigate(`/workspace?finish=${site.id}`)}>Finish setup</Button>
    </div>
  );
}
