#!/usr/bin/env node

/*
 * Copyright (C) 2023 Amazon.com, Inc. or its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

import { Construct } from 'constructs';
import { CacheStorage } from '@project-lakechain/core';
import { S3EventTrigger } from '@project-lakechain/s3-event-trigger';
import { S3StorageConnector } from '@project-lakechain/s3-storage-connector';

import {
  FfmpegProcessor,
  CloudEvent,
  FfmpegUtils,
  Ffmpeg
} from '@project-lakechain/ffmpeg-processor';

/**
 * This intent is a function that will get executed in the cloud
 * by the FFMPEG middleware. It takes a video input and extracts
 * the audio from it.
 * @param events the events to process, in this case there will
 * be only one event, as video files are processed sequentially.
 * @param ffmpeg the FFMPEG instance.
 * @param utils a set of utilities to interact with the FFMPEG
 * middleware.
 * @returns the FFMPEG chain.
 */
const intent = async (events: CloudEvent[], ffmpeg: Ffmpeg, utils: FfmpegUtils) => {
  const videos = events.filter(
    (event) => event.data().document().mimeType() === 'video/mp4'
  );

  // Create the FFMPEG chain.
  return (ffmpeg()
    .input(utils.file(videos[0]))
    .noVideo()
    .save('output.mp3')
  );
};

/**
 * An example stack showcasing how to use Project Lakechain
 * to extract the audio track from a video using the FFMPEG
 * processor.
 *
 * The pipeline looks as follows:
 *
 * ┌──────────────┐   ┌───────────────────┐   ┌─────────────┐
 * │   S3 Input   ├──►│  FFMPEG Processor ├──►│  S3 Output  │
 * └──────────────┘   └───────────────────┘   └─────────────┘
 *
 */
export class AudioExtractionPipeline extends cdk.Stack {

  /**
   * Stack constructor.
   */
  constructor(scope: Construct, id: string, env: cdk.StackProps) {
    super(scope, id, {
      description: 'A pipeline using FFMPEG to extract audio from video files.',
      ...env
    });

    // The VPC in which the FFMPEG processor will be deployed.
    const vpc = this.createVpc('Vpc');

    ///////////////////////////////////////////
    ///////         S3 Storage          ///////
    ///////////////////////////////////////////

    // The source bucket.
    const source = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true
    });

    // The destination bucket.
    const destination = new s3.Bucket(this, 'Destination', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enforceSSL: true
    });

    // The cache storage.
    const cache = new CacheStorage(this, 'Cache', {});

    ///////////////////////////////////////////
    ///////     Lakechain Pipeline      ///////
    ///////////////////////////////////////////

    // Create the S3 trigger monitoring the bucket
    // for uploaded objects.
    const trigger = new S3EventTrigger.Builder()
      .withScope(this)
      .withIdentifier('Trigger')
      .withCacheStorage(cache)
      .withBucket(source)
      .build();

    trigger
      .pipe(
        // The FFMPEG processor extracts the audio from the video.
        new FfmpegProcessor.Builder()
          .withScope(this)
          .withIdentifier('FfmpegProcessor')
          .withCacheStorage(cache)
          .withVpc(vpc)
          .withIntent(intent)
          .build()
      )
      .pipe(
        // Write the results to the destination bucket.
        new S3StorageConnector.Builder()
          .withScope(this)
          .withIdentifier('Storage')
          .withCacheStorage(cache)
          .withDestinationBucket(destination)
          .build()
      );

    // Display the source bucket information in the console.
    new cdk.CfnOutput(this, 'SourceBucketName', {
      description: 'The name of the source bucket.',
      value: source.bucketName
    });

    // Display the destination bucket information in the console.
    new cdk.CfnOutput(this, 'DestinationBucketName', {
      description: 'The name of the destination bucket.',
      value: destination.bucketName
    });
  }

  /**
   * @param id the VPC identifier.
   * @returns a new VPC with a public, private and isolated
   * subnets for the pipeline.
   */
  private createVpc(id: string): ec2.IVpc {
    return (new ec2.Vpc(this, id, {
      enableDnsSupport: true,
      enableDnsHostnames: true,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/20'),
      maxAzs: 1,
      subnetConfiguration: [{
        // Used by NAT Gateways to provide Internet access
        // to the containers.
        name: 'public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 28
      }, {
        // Used by the containers.
        name: 'private',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        cidrMask: 24
      }, {
        // Used by EFS.
        name: 'isolated',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 28
      }]
    }));
  }
}

// Creating the CDK application.
const app = new cdk.App();

// Environment variables.
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_DEFAULT_ACCOUNT;
const region  = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_DEFAULT_REGION;

// Deploy the stack.
new AudioExtractionPipeline(app, 'AudioExtractionPipeline', {
  env: {
    account,
    region
  }
});
