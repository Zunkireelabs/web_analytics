import { useEffect } from 'react';

// Approval emails sent before the Sign in button existed link to /verify-email?token=…. That link is
// still good, so it hands the token to the sign-in page, which now does what this page used to.
export default function VerifyEmail() {
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') || '';
    window.location.replace(token ? `/login?token=${encodeURIComponent(token)}` : '/login');
  }, []);
  return <div className="p-8 text-gray-400">Loading…</div>;
}
