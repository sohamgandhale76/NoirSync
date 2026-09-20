import { useState } from 'react';
import { User } from '../types';
import { AuthModal } from './AuthModal';

interface AccountBadgeProps {
  user: User | null;
  isAuthenticated: boolean;
  onLogin: (identifier: string, pass: string) => Promise<any>;
  onRegister: (data: { email: string; username: string; password: string; displayName?: string }) => Promise<any>;
  onLogout: () => Promise<void>;
}

export function AccountBadge({
  user,
  isAuthenticated,
  onLogin,
  onRegister,
  onLogout,
}: AccountBadgeProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<'login' | 'register'>('login');
  const [menuOpen, setMenuOpen] = useState(false);

  const openModal = (tab: 'login' | 'register') => {
    setModalTab(tab);
    setModalOpen(true);
    setMenuOpen(false);
  };

  const displayName = user?.displayName || user?.username || 'User';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <>
      <div className="relative inline-flex items-center gap-2">
        {isAuthenticated ? (
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-noir-graphite/80 hover:bg-noir-graphite border border-noir-border/60 hover:border-accent-gold/40 transition-all text-left group"
              title="Account Menu"
            >
              <div className="w-6 h-6 rounded-full bg-accent-gold/20 border border-accent-gold/50 flex items-center justify-center font-mono text-[11px] font-bold text-accent-gold">
                {initial}
              </div>
              <div className="flex flex-col">
                <span className="font-ui text-xs font-semibold text-noir-white group-hover:text-accent-gold transition-colors leading-tight">
                  {displayName}
                </span>
                {user?.username && (
                  <span className="font-mono text-[10px] text-noir-dim leading-tight">
                    @{user.username}
                  </span>
                )}
              </div>
              <span className="text-noir-dim text-xs ml-0.5">▾</span>
            </button>

            {menuOpen && (
              <div className="absolute right-0 mt-2 w-48 rounded-xl bg-noir-charcoal/95 border border-noir-border/80 shadow-2xl backdrop-blur-md py-1.5 z-50 animate-scale-in">
                <div className="px-3.5 py-2 border-b border-noir-border/50">
                  <p className="font-ui text-xs font-semibold text-noir-white truncate">{displayName}</p>
                  <p className="font-mono text-[10px] text-noir-ash truncate">{user?.email}</p>
                </div>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                  className="w-full text-left px-3.5 py-2 font-ui text-xs text-red-400 hover:bg-red-950/20 hover:text-red-300 transition-colors flex items-center gap-2"
                >
                  <span>⇥</span> Log Out
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-noir-graphite/60 border border-noir-border/50 text-noir-dim uppercase tracking-wider">
              Guest
            </span>
            <button
              onClick={() => openModal('login')}
              className="px-2.5 py-1 rounded-md text-xs font-ui text-noir-ash hover:text-noir-white hover:bg-noir-graphite/60 border border-transparent hover:border-noir-border/40 transition-all"
            >
              Log In
            </button>
            <button
              onClick={() => openModal('register')}
              className="px-2.5 py-1 rounded-md text-xs font-ui text-accent-gold hover:text-accent-gold/90 bg-accent-gold/10 hover:bg-accent-gold/20 border border-accent-gold/30 transition-all"
            >
              Sign Up
            </button>
          </div>
        )}
      </div>

      <AuthModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        defaultTab={modalTab}
        onLogin={onLogin}
        onRegister={onRegister}
      />
    </>
  );
}
