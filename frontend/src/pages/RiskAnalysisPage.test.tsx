// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RiskAnalysisPage } from './RiskAnalysisPage';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useAuthStore } from '../state/authStore';
import { useCollabStore } from '../state/collaborationStore';
import * as riskApi from '../api/riskAnalysis';
import * as collabApi from '../api/collaborationApi';

vi.mock('../api/riskAnalysis', () => ({
  analyzeCodeRisk: vi.fn(),
}));

vi.mock('../api/collaborationApi', () => ({
  getCollabFile: vi.fn(),
  getCollabSession: vi.fn(),
  listCollabFiles: vi.fn(),
}));

describe('RiskAnalysisPage - Main Editor and Collaboration files', () => {
  afterEach(() => {
    cleanup();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();

    // Reset workspace store with one main editor file
    useWorkspaceStore.setState({
      nodes: {
        'main-1': {
          id: 'main-1',
          name: 'app.py',
          type: 'file',
          parentId: null,
          language: 'python',
          content: 'print("hello main")',
        },
      },
      activeFileId: 'main-1',
    });

    // Reset auth store
    useAuthStore.setState({
      user: {
        id: 'user-123',
        displayName: 'Alice',
        token: 'test-jwt-token',
      },
      isLoading: false,
      error: null,
    });

    // Reset collab store
    useCollabStore.setState({
      activeSession: null,
      sessionFiles: [],
      activeFileId: null,
      isLoading: false,
      sessionError: null,
    });
  });

  it('renders Main Editor files when no collaboration session is active', () => {
    render(
      <MemoryRouter>
        <RiskAnalysisPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Risk Analysis')).toBeDefined();
    expect(screen.getByText(/No active collaboration session/i)).toBeDefined();
    expect(screen.getByRole('option', { name: 'app.py (Main Editor)' })).toBeDefined();
  });

  it('includes and groups files from BOTH Main Editor and active Collaboration session', () => {
    useCollabStore.setState({
      activeSession: {
        session_id: 'sess-1234-5678-90ab',
        name: 'Team Collab Session',
        owner_id: 'user-123',
        status: 'active',
      },
      sessionFiles: [
        {
          id: 'collab-file-1',
          session_id: 'sess-1234-5678-90ab',
          path: 'server.py',
          language: 'python',
          updated_at: '2026-10-12T00:00:00Z',
          content: 'import socket\n',
        },
      ],
      activeFileId: 'collab-file-1',
      isLoading: false,
      sessionError: null,
    });

    render(
      <MemoryRouter>
        <RiskAnalysisPage />
      </MemoryRouter>,
    );

    // Active room banner
    expect(screen.getByText('Team Collab Session')).toBeDefined();
    expect(screen.getByText('Active Room')).toBeDefined();

    // Filter tabs
    expect(screen.getByRole('tab', { name: /All Files \(2\)/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Main Editor \(1\)/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /Collaboration \(1\)/i })).toBeDefined();

    // Options for both sources
    expect(screen.getByRole('option', { name: 'app.py (Main Editor)' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'server.py (Collaboration)' })).toBeDefined();
  });

  it('fetches latest shared code and runs analysis when a collaboration file is selected', async () => {
    useCollabStore.setState({
      activeSession: {
        session_id: 'sess-1234-5678-90ab',
        name: 'Team Room',
        owner_id: 'user-123',
        status: 'active',
      },
      sessionFiles: [
        {
          id: 'collab-file-1',
          session_id: 'sess-1234-5678-90ab',
          path: 'network.py',
          language: 'python',
          updated_at: '2026-10-12T00:00:00Z',
          content: 'old stale content',
        },
      ],
      activeFileId: 'collab-file-1',
      isLoading: false,
      sessionError: null,
    });

    vi.mocked(collabApi.getCollabFile).mockResolvedValueOnce({
      id: 'collab-file-1',
      session_id: 'sess-1234-5678-90ab',
      path: 'network.py',
      language: 'python',
      content: 'import socket\ns = socket.socket()',
      updated_at: '2026-10-12T01:00:00Z',
    });

    vi.mocked(riskApi.analyzeCodeRisk).mockResolvedValueOnce({
      decision: 'flag',
      score: 55,
      thresholds: { flag: 40, block: 80 },
      findings: [
        {
          rule_code: 'py.net_socket',
          source: 'rule',
          category: 'network',
          severity: 'medium',
          confidence: 0.6,
          line_start: 1,
          line_end: 2,
          message: 'Raw socket creation detected',
          snippet: 's = socket.socket()',
        },
      ],
      model: 'rules+ml',
      ml_score: 50,
      fallback_reason: null,
      latency_ms: 12.5,
      assessment_id: 'assess-123',
      truncated: false,
      error: null,
      reason: null,
    });

    render(
      <MemoryRouter>
        <RiskAnalysisPage />
      </MemoryRouter>,
    );

    // Switch selection to the collaboration file
    const select = screen.getByLabelText('File');
    fireEvent.change(select, { target: { value: 'collab:collab-file-1' } });

    // Click Analyze
    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' });
    fireEvent.click(analyzeBtn);

    // Verify latest shared code was fetched via getCollabFile
    await waitFor(() => {
      expect(collabApi.getCollabFile).toHaveBeenCalledWith(
        'sess-1234-5678-90ab',
        'collab-file-1',
        'test-jwt-token',
      );
    });

    // Verify analyzeCodeRisk was called with the latest content
    expect(riskApi.analyzeCodeRisk).toHaveBeenCalledWith(
      'python',
      'import socket\ns = socket.socket()',
      'test-jwt-token',
    );

    // Verify result card rendered
    await waitFor(() => {
      expect(screen.getByText('Flag')).toBeDefined();
      expect(screen.getByText('55.0')).toBeDefined();
      expect(screen.getByText('Raw socket creation detected')).toBeDefined();
    });
  });

  it('handles empty collaboration sessions gracefully', () => {
    useCollabStore.setState({
      activeSession: {
        session_id: 'sess-empty',
        name: 'Empty Room',
        owner_id: 'user-123',
        status: 'active',
      },
      sessionFiles: [],
      activeFileId: null,
      isLoading: false,
      sessionError: null,
    });

    render(
      <MemoryRouter>
        <RiskAnalysisPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Empty Room')).toBeDefined();
    expect(screen.getByText(/0 shared files/i)).toBeDefined();
    // Main editor file is still selectable and usable
    expect(screen.getByRole('option', { name: 'app.py (Main Editor)' })).toBeDefined();
  });

  it('handles closed collaboration sessions with a clear warning notice', () => {
    useCollabStore.setState({
      activeSession: {
        session_id: 'sess-closed',
        name: 'Closed Room',
        owner_id: 'user-123',
        status: 'closed',
      },
      sessionFiles: [
        {
          id: 'f-closed',
          session_id: 'sess-closed',
          path: 'closed.py',
          language: 'python',
          updated_at: '2026-10-12T00:00:00Z',
          content: 'print(1)',
        },
      ],
      activeFileId: 'f-closed',
      isLoading: false,
      sessionError: null,
    });

    render(
      <MemoryRouter>
        <RiskAnalysisPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/This collaboration session is closed/i)).toBeDefined();
  });

  it('handles unavailable / deleted collaboration files with a clear error', async () => {
    useCollabStore.setState({
      activeSession: {
        session_id: 'sess-1',
        name: 'Active Room',
        owner_id: 'user-123',
        status: 'active',
      },
      sessionFiles: [
        {
          id: 'deleted-file',
          session_id: 'sess-1',
          path: 'deleted.py',
          language: 'python',
          updated_at: '2026-10-12T00:00:00Z',
          content: '',
        },
      ],
      activeFileId: 'deleted-file',
      isLoading: false,
      sessionError: null,
    });

    vi.mocked(collabApi.getCollabFile).mockRejectedValueOnce(
      new Error('Request failed with status 404 (File not found)'),
    );

    render(
      <MemoryRouter>
        <RiskAnalysisPage />
      </MemoryRouter>,
    );

    const select = screen.getByLabelText('File');
    fireEvent.change(select, { target: { value: 'collab:deleted-file' } });

    const analyzeBtn = screen.getByRole('button', { name: 'Analyze' });
    fireEvent.click(analyzeBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Shared file "deleted.py" was not found/i),
      ).toBeDefined();
    });
  });
});
