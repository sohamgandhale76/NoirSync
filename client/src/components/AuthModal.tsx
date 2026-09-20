import { useState } from 'react';
import { GlassPanel } from './ui/GlassPanel';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: (identifier: string, pass: string) => Promise<any>;
  onRegister: (data: { email: string; username: string; password: string; displayName?: string }) => Promise<any>;
  defaultTab?: 'login' | 'register';
}

export function AuthModal({
  isOpen,
  onClose,
  onLogin,
  onRegister,
  defaultTab = 'login',
}: AuthModalProps) {
  const [tab, setTab] = useState<'login' | 'register'>(defaultTab);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Login form state
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Register form state
  const [regEmail, setRegEmail] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regPassword, setRegPassword] = useState('');

  if (!isOpen) return null;

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onLogin(loginIdentifier, loginPassword);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await onRegister({
        email: regEmail,
        username: regUsername,
        displayName: regDisplayName || undefined,
        password: regPassword,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <GlassPanel className="relative w-full max-w-md p-6 sm:p-8 space-y-6 border border-noir-border/80 shadow-2xl animate-scale-in">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-noir-ash hover:text-noir-white text-lg transition-colors p-1"
          aria-label="Close modal"
        >
          ✕
        </button>

        {/* Title */}
        <div className="text-center space-y-1">
          <h2 className="font-display text-2xl font-bold tracking-tight text-noir-white">
            {tab === 'login' ? 'Welcome Back' : 'Create Account'}
          </h2>
          <p className="font-body text-xs text-noir-ash">
            {tab === 'login'
              ? 'Sign in to access your persistent library and playlists'
              : 'Upgrade to a permanent NoirSync account'}
          </p>
        </div>

        {/* Tab switch */}
        <div className="flex rounded-lg overflow-hidden border border-noir-border bg-noir-graphite/80 p-0.5">
          <button
            type="button"
            onClick={() => { setTab('login'); setError(null); }}
            className={`flex-1 py-2 text-xs font-mono uppercase tracking-wider rounded-md transition-all ${
              tab === 'login'
                ? 'bg-accent-gold/20 text-accent-gold font-semibold shadow-sm'
                : 'text-noir-ash hover:text-noir-white'
            }`}
          >
            Log In
          </button>
          <button
            type="button"
            onClick={() => { setTab('register'); setError(null); }}
            className={`flex-1 py-2 text-xs font-mono uppercase tracking-wider rounded-md transition-all ${
              tab === 'register'
                ? 'bg-accent-gold/20 text-accent-gold font-semibold shadow-sm'
                : 'text-noir-ash hover:text-noir-white'
            }`}
          >
            Create Account
          </button>
        </div>

        {/* Error alert */}
        {error && (
          <div className="p-3 rounded-lg bg-red-950/40 border border-red-800/60 text-red-300 font-ui text-xs animate-shake">
            {error}
          </div>
        )}

        {/* Login Form */}
        {tab === 'login' && (
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label className="block font-mono text-[10px] tracking-[0.2em] text-noir-ash uppercase mb-1.5">
                Email or Username
              </label>
              <input
                type="text"
                value={loginIdentifier}
                onChange={(e) => setLoginIdentifier(e.target.value)}
                placeholder="name@example.com or username"
                required
                autoComplete="username"
                className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-1 focus:ring-accent-gold/30 placeholder:text-noir-dim"
              />
            </div>

            <div>
              <label className="block font-mono text-[10px] tracking-[0.2em] text-noir-ash uppercase mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
                className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-1 focus:ring-accent-gold/30 placeholder:text-noir-dim"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-accent-gold hover:bg-accent-gold/90 text-noir-black font-semibold text-sm rounded-lg transition-all flex items-center justify-center gap-2"
            >
              {loading && <Spinner size="sm" />}
              {loading ? 'Logging In…' : 'Log In'}
            </Button>
          </form>
        )}

        {/* Register Form */}
        {tab === 'register' && (
          <form onSubmit={handleRegisterSubmit} className="space-y-4">
            <div>
              <label className="block font-mono text-[10px] tracking-[0.2em] text-noir-ash uppercase mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-1 focus:ring-accent-gold/30 placeholder:text-noir-dim"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-mono text-[10px] tracking-[0.2em] text-noir-ash uppercase mb-1.5">
                  Username
                </label>
                <input
                  type="text"
                  value={regUsername}
                  onChange={(e) => setRegUsername(e.target.value)}
                  placeholder="username"
                  required
                  autoComplete="username"
                  pattern="^[a-zA-Z0-9_]{3,30}$"
                  title="3–30 characters (letters, numbers, underscores)"
                  className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-1 focus:ring-accent-gold/30 placeholder:text-noir-dim"
                />
              </div>
              <div>
                <label className="block font-mono text-[10px] tracking-[0.2em] text-noir-ash uppercase mb-1.5">
                  Display Name
                </label>
                <input
                  type="text"
                  value={regDisplayName}
                  onChange={(e) => setRegDisplayName(e.target.value)}
                  placeholder="Your Name"
                  maxLength={50}
                  className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-1 focus:ring-accent-gold/30 placeholder:text-noir-dim"
                />
              </div>
            </div>

            <div>
              <label className="block font-mono text-[10px] tracking-[0.2em] text-noir-ash uppercase mb-1.5">
                Password (min 8 chars)
              </label>
              <input
                type="password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={8}
                autoComplete="new-password"
                className="w-full bg-noir-graphite border border-noir-border text-noir-white px-3.5 py-2.5 rounded-lg font-ui text-sm focus:outline-none focus:border-accent-gold/60 focus:ring-1 focus:ring-accent-gold/30 placeholder:text-noir-dim"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-accent-gold hover:bg-accent-gold/90 text-noir-black font-semibold text-sm rounded-lg transition-all flex items-center justify-center gap-2"
            >
              {loading && <Spinner size="sm" />}
              {loading ? 'Creating Account…' : 'Create Account'}
            </Button>
          </form>
        )}
      </GlassPanel>
    </div>
  );
}
