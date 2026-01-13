
import { KafkaEventConsumer } from '../../src/services/KafkaEventConsumer';
import { notificationRouter } from '../../src/services/NotificationRouter';
import { DeadLetterQueue } from '../../src/models';
import { logger } from '../../src/utils/logger';

// Mock dependencies
jest.mock('../../src/services/NotificationRouter');
jest.mock('../../src/models/postgres/DeadLetterQueue', () => ({
    DeadLetterQueue: {
        create: jest.fn(),
    }
}));
jest.mock('../../src/utils/logger');

// Mock KafkaJS
const mockConsumer = {
    connect: jest.fn(),
    subscribe: jest.fn(),
    run: jest.fn(),
    disconnect: jest.fn(),
};

const mockKafka = {
    consumer: jest.fn().mockReturnValue(mockConsumer),
};

jest.mock('kafkajs', () => ({
    Kafka: jest.fn().mockImplementation(() => mockKafka),
    logLevel: { WARN: 4 },
}));

describe('KafkaEventConsumer Integration', () => {
    let kafkaConsumer: KafkaEventConsumer;

    beforeEach(() => {
        jest.clearAllMocks();
        kafkaConsumer = new KafkaEventConsumer();
    });

    it('should start the consumer and subscribe to topics', async () => {
        await kafkaConsumer.start();
        expect(mockConsumer.connect).toHaveBeenCalled();
        expect(mockConsumer.subscribe).toHaveBeenCalled();
        expect(mockConsumer.run).toHaveBeenCalledWith(expect.objectContaining({
            eachBatch: expect.any(Function),
        }));
    });

    it('should process a valid message successfully', async () => {
        await kafkaConsumer.start();
        const runConfig = mockConsumer.run.mock.calls[0][0];
        const eachBatch = runConfig.eachBatch;

        const mockMessage = {
            offset: '1',
            value: Buffer.from(JSON.stringify({
                eventType: 'transfer_completed',
                payload: { userId: 'user123', amount: 100 },
                correlationId: 'req123'
            })),
        };

        const mockBatch = {
            topic: 'transaction-events',
            partition: 0,
            messages: [mockMessage],
        };

        const mockResolveOffset = jest.fn();
        const mockHeartbeat = jest.fn();
        const mockIsRunning = jest.fn().mockReturnValue(true);

        // Setup successful routing
        (notificationRouter.route as jest.Mock).mockResolvedValue({
            notificationId: 'notif123',
            results: [{ channel: 'websocket', status: 'sent' }]
        });

        await eachBatch({
            batch: mockBatch,
            resolveOffset: mockResolveOffset,
            heartbeat: mockHeartbeat,
            isRunning: mockIsRunning,
        });

        expect(notificationRouter.route).toHaveBeenCalled();
        expect(mockResolveOffset).toHaveBeenCalledWith('1');
    });

    it('should handle malformed JSON by sending to DLQ', async () => {
        await kafkaConsumer.start();
        const runConfig = mockConsumer.run.mock.calls[0][0];
        const eachBatch = runConfig.eachBatch;

        const mockMessage = {
            offset: '2',
            value: Buffer.from('{ invalid json }'),
        };

        const mockBatch = {
            topic: 'transaction-events',
            partition: 0,
            messages: [mockMessage],
        };

        const mockResolveOffset = jest.fn();
        const mockHeartbeat = jest.fn();
        const mockIsRunning = jest.fn().mockReturnValue(true);

        await eachBatch({
            batch: mockBatch,
            resolveOffset: mockResolveOffset,
            heartbeat: mockHeartbeat,
            isRunning: mockIsRunning,
        });

        // Should try to route to DLQ (generic addToDLQ or log error)
        // Since invalid JSON means we can't get userId, it likely logs error but handles it gracefully
        // verify resolveOffset is NOT called if we decided to skip/DLQ and return.
        // Wait, looking at my code implementation:
        // catch(e) -> addToDLQ -> return.
        // Inside run:
        // await processMessage -> resolveOffset.
        // processMessage returns void. If it returns (even after addToDLQ), resolveOffset is called?
        // Let's check logic:
        // try { await processMessage; resolveOffset; } catch { ... }
        // processMessage does NOT throw for handled errors (DLQ success).
        // So resolveOffset SHOULD be called.
        expect(mockResolveOffset).toHaveBeenCalledWith('2');
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON'), expect.any(Object));
    });

    it('should send to DLQ table if processing fails', async () => {
        await kafkaConsumer.start();
        const runConfig = mockConsumer.run.mock.calls[0][0];
        const eachBatch = runConfig.eachBatch;

        const mockMessage = {
            offset: '3',
            value: Buffer.from(JSON.stringify({
                eventType: 'transfer_completed',
                payload: { userId: 'user123' },
                correlationId: 'req123'
            })),
        };

        const mockBatch = {
            topic: 'transaction-events',
            partition: 0,
            messages: [mockMessage],
        };

        const mockResolveOffset = jest.fn();
        const mockHeartbeat = jest.fn();
        const mockIsRunning = jest.fn().mockReturnValue(true);

        // Simulate NotificationRouter failure
        (notificationRouter.route as jest.Mock).mockRejectedValue(new Error('DB Error'));

        // Mock DeadLetterQueue create success
        (DeadLetterQueue.create as jest.Mock).mockResolvedValue({});

        await eachBatch({
            batch: mockBatch,
            resolveOffset: mockResolveOffset,
            heartbeat: mockHeartbeat,
            isRunning: mockIsRunning,
        });

        expect(notificationRouter.route).toHaveBeenCalled();
        expect(DeadLetterQueue.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user123',
            failureReason: 'DB Error',
        }));
        expect(mockResolveOffset).toHaveBeenCalledWith('3');
    });
});
