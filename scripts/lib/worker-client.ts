import axios, { AxiosInstance } from 'axios';
import 'dotenv/config';

const BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const INTERNAL_KEY = process.env.WORKER_INTERNAL_KEY || '';

class WorkerClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: { 'X-Internal-Key': INTERNAL_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  // Books
  async createBook(data: Record<string, unknown>) {
    return (await this.http.post('/internal/books', data)).data;
  }

  async updateBook(id: string, data: Record<string, unknown>) {
    return (await this.http.put(`/internal/books/${id}`, data)).data;
  }

  async createChapters(bookId: string, chapters: Record<string, unknown>[]) {
    return (await this.http.post(`/internal/books/${bookId}/chapters`, { chapters })).data;
  }

  // Jobs
  async pullNextJob(status = 'queued', limit = 1) {
    return (await this.http.get('/internal/jobs', { params: { status, limit } })).data;
  }

  async updateJob(id: string, data: Record<string, unknown>) {
    return (await this.http.put(`/internal/jobs/${id}`, data)).data;
  }

  async createJob(gutenbergId: number, priority: number) {
    return (await this.http.post('/internal/jobs', { gutenbergId, priority })).data;
  }

  // Check existing
  async checkExistingBooks(gutenbergIds: number[]): Promise<number[]> {
    const { data } = await this.http.get('/internal/books/exists', {
      params: { gutenberg_ids: gutenbergIds.join(',') },
    });
    return data.existingIds || [];
  }
}

export const workerClient = new WorkerClient();
