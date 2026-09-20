import { useState, useEffect, useCallback } from 'react';
import { User } from '../types';
import { SERVER_URL } from '../lib/constants';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${SERVER_URL}/api/auth/me`, {
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch profile (status: ${res.status})`);
      }
      const data = await res.json();
      if (data.authenticated && data.user) {
        setUser(data.user);
      } else {
        setUser(data.user ? { ...data.user, isGuest: true } : null);
      }
      return data;
    } catch (err: any) {
      setError(err.message || 'Failed to check authentication');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const register = useCallback(async (data: {
    email: string;
    username: string;
    password: string;
    displayName?: string;
  }) => {
    setError(null);
    const res = await fetch(`${SERVER_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
    });

    const resData = await res.json();
    if (!res.ok) {
      const msg = resData.error || 'Registration failed';
      setError(msg);
      throw new Error(msg);
    }

    setUser(resData.user);
    return resData.user;
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    setError(null);
    const res = await fetch(`${SERVER_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ identifier, password }),
    });

    const resData = await res.json();
    if (!res.ok) {
      const msg = resData.error || 'Login failed';
      setError(msg);
      throw new Error(msg);
    }

    setUser(resData.user);
    return resData.user;
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    try {
      await fetch(`${SERVER_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Best-effort
    }
    // Refresh to obtain a new guest session
    await refreshUser();
  }, [refreshUser]);

  const updateProfile = useCallback(async (updates: {
    displayName?: string;
    username?: string;
    avatarUrl?: string | null;
  }) => {
    setError(null);
    const res = await fetch(`${SERVER_URL}/api/auth/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(updates),
    });

    const resData = await res.json();
    if (!res.ok) {
      const msg = resData.error || 'Profile update failed';
      setError(msg);
      throw new Error(msg);
    }

    setUser(resData.user);
    return resData.user;
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  return {
    user,
    loading,
    error,
    isAuthenticated: Boolean(user && !user.isGuest && user.email),
    isGuest: Boolean(!user || user.isGuest),
    refreshUser,
    register,
    login,
    logout,
    updateProfile,
  };
}
