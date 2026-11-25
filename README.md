# RapidPro

[![tag](https://img.shields.io/github/tag/nyaruka/rapidpro.svg)](https://github.com/nyaruka/rapidpro/releases)
[![Build Status](https://github.com/nyaruka/rapidpro/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nyaruka/rapidpro/actions?query=workflow%3ACI)

RapidPro is a cloud based SaaS developed by [TextIt](https://textit.com) for visually building interactive messaging
applications. To see what it can do, signup for a free trial account at [textit.com](https://textit.com).

## Technology Stack

- [PostgreSQL](https://www.postgresql.org)
- [Valkey](https://valkey.io)
- [Elasticsearch](https://www.elastic.co/elasticsearch)
- [S3](https://aws.amazon.com/s3/)
- [DynamoDB](https://aws.amazon.com/dynamodb/)
- [Cloudwatch](https://aws.amazon.com/cloudwatch/)

## Snapshots

Every 6 months we [publish snapshots](https://github.com/nyaruka/rapidpro/discussions) for other deployments,
which are essentially a set of stable versions of the components that make up the platform. To upgrade from
one snapshot to the next, you must first install and run the migrations for the latest snapshot you are on,
then every snapshot afterwards.
