import type { AuthContext } from "../types.js";

export type AuthRequest = {
	headers: Record<string, string | string[] | undefined>;
};

export type AuthProvider = {
	authenticate(request: AuthRequest): Promise<AuthContext>;
};
