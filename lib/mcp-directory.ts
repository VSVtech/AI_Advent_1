export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

export type McpServerInfo = {
  id: string;
  name: string;
  location: string;
  hint: string;
  status: 'connected' | 'unavailable';
  tools: McpToolInfo[];
};

export type McpDirectoryResponse = {
  servers: McpServerInfo[];
};
