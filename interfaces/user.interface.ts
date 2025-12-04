// User-related interfaces for type safety

export interface CreateUserDTO {
    name: string;
    email: string;
    password: string;
}

export interface LoginUserDTO {
    email: string;
    password: string;
}

export interface UserResponse {
    id: number;
    name: string;
    email: string;
    createdAt: Date;
    updatedAt: Date;
}

