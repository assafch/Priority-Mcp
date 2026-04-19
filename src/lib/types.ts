/** Common Priority entity types used across tools */

export interface PriorityCustomer {
  CUSTNAME: string;
  CUSTDES: string;
  PHONE?: string;
  EMAIL?: string;
  WTAXNUM?: string;
  STATDES?: string;
  SNAME?: string; // sales rep
  CUSTBALANCE?: number;
  CREDITLIMIT?: number;
  [key: string]: unknown;
}

export interface PaginationParams {
  top?: number;
  skip?: number;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
