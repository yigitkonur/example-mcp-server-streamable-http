# Default command when running `make`
all: up

## build: Build the Docker image for the MCP server.
build:
	docker-compose build

## up: Build (if needed) and start the MCP server in the background.
up:
	docker-compose up --build -d

## down: Stop and remove all running services for this project.
down:
	docker-compose down

## logs: Tail the logs of the running services.
logs:
	docker-compose logs -f

## ps: Show the status of the running services.
ps:
	docker-compose ps

## restart: Restart all services.
restart:
	docker-compose restart

## shell: Get a shell inside the running MCP server container.
shell:
	docker-compose exec mcp-server sh

## prod-up: Start the production environment with Redis.
prod-up:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

## prod-down: Stop the production environment.
prod-down:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml down

## prod-logs: Tail the logs of the production environment.
prod-logs:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml logs -f

## prod-secure-up: Start production with Redis and proper secret management.
prod-secure-up:
	@test -f redis_password.txt || (echo "Error: redis_password.txt not found. Create it with: echo 'your-password' > redis_password.txt" && exit 1)
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.secrets.yml up --build -d

## prod-secure-down: Stop the secure production environment.
prod-secure-down:
	docker-compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.secrets.yml down

## clean: Remove all containers, images, and volumes for this project.
clean:
	docker-compose down -v --rmi all

## test-health: Test the health endpoint of the running server.
test-health:
	curl -f http://localhost:1453/health || echo "Health check failed"

## help: Display this help message.
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.PHONY: all build up down logs ps restart shell prod-up prod-down prod-logs clean test-health help