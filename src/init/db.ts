import dotenv from "dotenv";
import {PrismaClient} from "@prisma/client";
dotenv.config();

export class Database {
    prisma: PrismaClient;
    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
    }
}
const prisma = new PrismaClient();
export const connect = async () => new Database(prisma);
