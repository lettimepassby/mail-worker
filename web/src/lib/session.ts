import { createContext, useContext } from 'react';
import type { User } from '../api';

export const SessionContext = createContext<User | null>(null);

export function useSession(): User {
  const user = useContext(SessionContext);
  if (!user) throw new Error('useSession outside SessionContext');
  return user;
}

/** Lets pages open the mobile navigation drawer owned by AppLayout. */
export const NavContext = createContext<{ openNav: () => void }>({ openNav: () => {} });

export function useNav() {
  return useContext(NavContext);
}
