# =========================================================================
# Stage 1: The "Builder" Stage
#
# This stage installs all dependencies (including devDependencies),
# compiles the TypeScript to JavaScript, and prepares the production assets.
# =========================================================================
FROM node:20-alpine AS builder

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker's layer caching.
# This step only re-runs if these files change.
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies, including devDependencies needed for building
RUN npm ci

# Copy the rest of the application source code
COPY ./src ./src

# Run the build script defined in package.json to compile TypeScript to JavaScript
# This will create a `dist` folder.
RUN npm run build

# =========================================================================
# Stage 2: The "Production" Stage
#
# This stage starts from a fresh Node.js base image and copies only
# the compiled code and production dependencies. This creates a small
# and secure final image.
# =========================================================================
FROM node:20-alpine

WORKDIR /usr/src/app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Create a non-root user and group for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy package files again
COPY package*.json ./

# Install *only* production dependencies.
# The --omit=dev flag is critical for a lean production image.
RUN npm ci --omit=dev

# Copy the compiled JavaScript code from the 'builder' stage
COPY --from=builder /usr/src/app/dist ./dist

# Change ownership of all files to the non-root user
RUN chown -R appuser:appgroup /usr/src/app

# Switch to the non-root user
USER appuser

# The PORT environment variable is used by your production-server.ts
# Set a default value here. It can be overridden at runtime.
ENV PORT=1453

# Expose the port that the application will listen on.
# This is documentation for the user and for Docker networking.
EXPOSE ${PORT}

# Define the command to run the application
CMD [ "npm", "start" ]