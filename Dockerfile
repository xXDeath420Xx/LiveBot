FROM node:alpine

# Expose our database port
EXPOSE 3306

RUN mkdir -p 0755 /usr/src/certifried-announcer

# Set working directory
WORKDIR /usr/src/certifried-announcer

# Copy certifried announcer into container
COPY . /usr/src/certified-announcer/.

# Install npm packages
RUN npm i
