# Banking Notification Service

A production-grade multi-channel notification microservice for the NextGen Banking platform. Delivers real-time and asynchronous notifications via WebSocket, SMS (Twilio), Email (SendGrid), and Push (Firebase Cloud Messaging).

## Features

- **Multi-Channel Delivery**: WebSocket, SMS, Email, Push Notifications
- **User Preferences**: Granular control over notification channels and types
- **Quiet Hours**: Configurable do-not-disturb periods with critical alert bypass
- **Rate Limiting**: Per-user, per-channel limits to prevent notification fatigue
- **Deduplication**: Prevents duplicate notifications within configurable windows
- **Digest Mode**: Batch notifications into hourly/daily/weekly email summaries
- **Retry Logic**: Exponential backoff with Dead Letter Queue for failed notifications
- **Event-Driven**: Consumes events from Kafka topics (security, transaction, fraud, user)

## Architecture

```
┌─────────────────┐     ┌─────────────────────────────────────┐
│   Kafka Topics  │────▶│     Banking Notification Service    │
│  - security     │     │                                     │
│  - transaction  │     │  ┌─────────────┐  ┌──────────────┐ │
│  - fraud        │     │  │   Kafka     │  │  Notification│ │
│  - user         │     │  │  Consumer   │──│    Router    │ │
└─────────────────┘     │  └─────────────┘  └──────────────┘ │
                        │                          │          │
                        │            ┌─────────────┴──────────┤
                        │            ▼                        │
                        │  ┌────────────────────────────────┐ │
                        │  │     Channel Handlers           │ │
                        │  │  WebSocket│SMS│Email│Push      │ │
                        │  └────────────────────────────────┘ │
                        └─────────────────────────────────────┘
                                       │
               ┌───────────────────────┼───────────────────────┐
               ▼                       ▼                       ▼
        ┌───────────┐          ┌───────────┐           ┌───────────┐
        │  Twilio   │          │ SendGrid  │           │ Firebase  │
        │   (SMS)   │          │  (Email)  │           │  (Push)   │
        └───────────┘          └───────────┘           └───────────┘
```

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Express.js
- **Databases**: 
  - PostgreSQL (notification history)
  - MongoDB (user preferences)
  - Redis (queues, rate limiting, caching)
- **Message Queue**: Apache Kafka
- **External APIs**: Twilio, SendGrid, Firebase Admin SDK

## Quick Start

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Development Setup

1. **Clone and install dependencies**:
   ```bash
   cd banking-notification-service
   npm install
   ```

2. **Start infrastructure**:
   ```bash
   docker-compose up -d postgres mongo redis kafka zookeeper
   ```

3. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Start the service**:
   ```bash
   npm run dev
   ```

5. **Access the service**:
   - API: http://localhost:3003
   - Kafka UI: http://localhost:8081
   - Mongo Express: http://localhost:8082

### Running with Docker

```bash
docker-compose up --build
```

## API Endpoints

### Notifications (Service-to-Service)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/notifications/send` | Send notification to user |
| POST | `/api/notifications/batch` | Send batch notifications |

### Notifications (User-Facing)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notifications/history` | Get notification history |
| GET | `/api/notifications/unread/count` | Get unread count |
| GET | `/api/notifications/:id` | Get notification details |
| POST | `/api/notifications/:id/read` | Mark as read |
| POST | `/api/notifications/read-all` | Mark all as read |

### Preferences

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/preferences` | Get user preferences |
| PUT | `/api/preferences` | Update preferences |
| POST | `/api/preferences/devices` | Register push device |
| DELETE | `/api/preferences/devices/:id` | Unregister device |
| POST | `/api/preferences/unsubscribe` | Unsubscribe from all |
| POST | `/api/preferences/resubscribe` | Re-subscribe |

### Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/health` | Detailed health check |
| GET | `/api/admin/metrics` | Service metrics |
| GET | `/api/admin/dlq` | Dead Letter Queue items |
| POST | `/api/admin/retry/:id` | Manual retry |
| POST | `/api/admin/ratelimit/:userId/reset` | Reset rate limits |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Service port | 3003 |
| `DB_HOST` | PostgreSQL host | localhost |
| `MONGO_URL` | MongoDB connection URL | - |
| `REDIS_HOST` | Redis host | localhost |
| `KAFKA_BROKERS` | Kafka broker list | localhost:9092 |
| `TWILIO_ENABLED` | Enable SMS | false |
| `SENDGRID_ENABLED` | Enable Email | false |
| `FIREBASE_ENABLED` | Enable Push | false |

See `.env.example` for complete configuration options.

## Testing

```bash
# Run all tests
npm test

# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration

# Run with coverage
npm run test -- --coverage
```

## Metrics & Monitoring

The service exposes metrics at `/api/admin/metrics` including:

- Notification delivery rates
- Channel-specific success/failure rates
- Rate limit usage
- Retry queue size
- Dead Letter Queue size

## Security

- All API endpoints require authentication (JWT or API key)
- PII (phone, email) encrypted at rest using AES-256
- Rate limiting prevents notification spam
- Audit logging for compliance (PCI-DSS, GDPR)

## License

UNLICENSED - Proprietary
