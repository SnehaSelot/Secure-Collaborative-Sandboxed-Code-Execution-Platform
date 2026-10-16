import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import axios from 'axios';
import { apiClient } from './api/client';
import { AppRoutes } from './routes/AppRoutes';
import { useAuthStore } from './state/authStore';

function AuthExpiryHandler() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((state) => state.logout);

  useEffect(() => {
    const interceptor = apiClient.interceptors.response.use(
      (response) => response,
      (error: unknown) => {
        if (axios.isAxiosError(error) && error.response?.status === 401 && error.config?.headers?.Authorization) {
          logout();
          navigate('/login', {
            replace: true,
            state: { from: { pathname: location.pathname }, message: 'Your session has expired. Please sign in again.' },
          });
        }
        return Promise.reject(error);
      },
    );
    return () => apiClient.interceptors.response.eject(interceptor);
  }, [logout, navigate, location.pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthExpiryHandler />
      <AppRoutes />
    </BrowserRouter>
  );
}
