import { useState } from 'react';
import { api } from '../api.js';
import Logo from '../components/Logo.jsx';

export default function Login({ onAuthed }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.login(password);
      onAuthed();
    } catch {
      setErr('Wrong password. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-slate-900 to-indigo-900">
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div className="mb-3"><Logo size={36} /></div>
        <h1 className="text-lg font-semibold text-slate-900">Zunkiree Labs <span className="text-indigo-600">Analytics</span></h1>
        <p className="text-sm text-slate-500 mb-6">Enter the team password to continue.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3"
        />
        {err && <div className="text-sm text-red-600 mb-3">{err}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-indigo-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
