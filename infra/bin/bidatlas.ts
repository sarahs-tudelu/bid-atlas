#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { BidAtlasStack } from "../lib/bidatlas-stack";

const app = new cdk.App();

new BidAtlasStack(app, "BidAtlasStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
  },
  description: "BidAtlas React and FastAPI application",
});
