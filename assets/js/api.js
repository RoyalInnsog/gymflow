// Centralized API Wrapper for JSB Fitness
// Phase 1: Launch Stabilization

class ApiService {
    constructor() {
        this.baseUrl = '/api/v1';
        // Potential future addition: Cache store
        this.cache = new Map();
    }

    async fetch(endpoint, options = {}) {
        const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
        
        // Default options
        const fetchOptions = {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        };

        try {
            const response = await window.fetch(url, fetchOptions);
            
            // Handle HTTP errors globally
            if (!response.ok) {
                if (response.status === 401) {
                    console.error('Unauthorized access. Session might be expired.');
                }
                
                // Do not throw here if we want drop-in replacement, let the calling code handle it, 
                // OR we can throw if we know calling code checks res.ok
            }
            
            return response;
        } catch (error) {
            console.error(`[API Error] ${endpoint}:`, error);
            throw error;
        }
    }

    // Convenience methods
    async get(endpoint, options = {}) {
        return this.fetch(endpoint, { ...options, method: 'GET' });
    }

    async post(endpoint, data, options = {}) {
        return this.fetch(endpoint, {
            ...options,
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async put(endpoint, data, options = {}) {
        return this.fetch(endpoint, {
            ...options,
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async delete(endpoint, options = {}) {
        return this.fetch(endpoint, { ...options, method: 'DELETE' });
    }
}

// Export a single instance to be used globally
window.api = new ApiService();
