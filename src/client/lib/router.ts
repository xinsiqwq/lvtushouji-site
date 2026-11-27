import { createContext, useContext } from 'react';

export type RouteState = {
  pathname: string;
  search: string;
  hash: string;
};

export type RouterContextValue = RouteState & {
  navigate: (to: string, opts?: { replace?: boolean }) => void;
};

export const RouterContext = createContext<RouterContextValue>({
  pathname: '/',
  search: '',
  hash: '',
  navigate: () => {},
});

export function useRouter(): RouterContextValue {
  return useContext(RouterContext);
}
