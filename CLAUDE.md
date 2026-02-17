# Gutenberg Platform - Project Guidelines

## Project Overview

Independent microservice for acquiring, processing, and managing Project Gutenberg public domain books. Supplies content to Readmigo via API.

## Architecture

- **worker/**: Cloudflare Worker (Hono + Drizzle + D1) - REST API + Cron + Queue
- **scripts/**: Node.js scripts running on Droplet (PM2) - EPUB processing
- **web/**: Cloudflare Pages - Admin dashboard + public catalog

## Development Rules

### Default Environment
- Default is **production** unless explicitly specified
- Worker: Cloudflare Workers
- Database: Cloudflare D1
- Storage: Cloudflare R2 (bucket: gutenberg-production)

### Backend Operations
- Output modification plan before making changes
- Only execute after review approval (input 1 to confirm, 2 to reject)

### Deployment
- Push to main → GitHub Actions auto-deploy Worker + Pages
- No manual deployment needed

### Long-Running Tasks
- Server: mcloud88.com (159.65.143.131), user: readmigo
- Use PM2 for all long-running scripts

## Readmigo Team Knowledge Base

All cross-project docs: `/Users/HONGBGU/Documents/readmigo-repos/docs/`

## Design Document

See: `docs/plans/2026-02-17-gutenberg-platform-design.md`
See: `docs/plans/2026-02-17-gutenberg-platform-implementation.md`
